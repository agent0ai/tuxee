import { locale, t, errorText } from './i18n';
import { APIError, button, el, requestHeaders } from './ui';
import { compactSize } from './monitor-values';

export function folderSize(paths: string[], signal: AbortSignal): HTMLElement {
    const row = el('dd', 'property-size'), value = el('span'), status = el('span', 'muted');
    let total = 0, request: AbortController | undefined;
    const render = (partial: boolean) => {
        value.textContent = `${partial ? '~' : ''}${compactSize(total, 1024, true)}`;
        value.title = `${total.toLocaleString(locale())} B`;
    };
    const label = (text: string) => {
        control.textContent = control.title = text;
        control.setAttribute('aria-label', text);
    };
    const stop = (manual: boolean) => {
        request?.abort(); request = undefined;
        render(true); status.textContent = manual ? t("file.size.stopped") : t("file.size.interrupted");
        label(t("files.calculate")); control.hidden = !manual;
    };
    const calculate = async () => {
        const current = request = new AbortController();
        total = 0; render(true); label(t('file.size.stop')); control.hidden = false; status.textContent = t("file.size.calculating");
        let timer: ReturnType<typeof setTimeout>;
        const heartbeat = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { if (request === current) stop(false); }, 10000);
        };
        heartbeat();
        try {
            const headers = requestHeaders();
            const response = await fetch('/api/file-size', {
                method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths }), signal: current.signal
            });
            if (!response.ok) {
                if (response.status === 401 || response.status === 403) window.dispatchEvent(new Event('tuxee-unauthorized'));
                if (response.status >= 500) window.dispatchEvent(new Event('tuxee-connection-check'));
                const data = await response.json();
                throw new APIError(errorText(data), response.status);
            }
            if (!response.headers.get('Content-Type')?.startsWith('application/x-ndjson') || !response.body)
                throw new Error(t("file.size.unexpectedSizeResponse"));
            const reader = response.body.getReader(), decoder = new TextDecoder();
            let pending = '', complete = false;
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                current.signal.throwIfAborted();
                pending += decoder.decode(chunk.value, { stream: true });
                if (pending.length > 65536) throw new Error(t("file.size.unexpectedSizeResponse"));
                let newline: number;
                while ((newline = pending.indexOf('\n')) >= 0) {
                    const progress = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
                    if (!Number.isFinite(progress.size) || progress.size < 0 || !Number.isSafeInteger(progress.skipped) ||
                        progress.skipped < 0 || typeof progress.done !== 'boolean' || complete) throw new Error(t("file.size.unexpectedSizeResponse"));
                    heartbeat(); total = progress.size; complete = progress.done;
                    render(!complete || progress.skipped > 0);
                    status.textContent = progress.skipped ? t("files.skipped", { count: progress.skipped }) : complete ? '' : t("file.size.calculating");
                    status.title = progress.skipped ? t("file.size.partialTotalReason") : '';
                    control.hidden = complete;
                }
            }
            if (!complete) throw new Error(t("file.size.sizeCalculationInterrupted"));
        } catch (error) {
            if (!current.signal.aborted) {
                render(true); control.hidden = true;
                status.textContent = error instanceof APIError ? error.message : t("file.size.interrupted");
                if (!(error instanceof APIError)) window.dispatchEvent(new Event('tuxee-connection-check'));
            }
        } finally {
            clearTimeout(timer!); current.abort();
            if (request === current) request = undefined;
        }
    };
    const control = button(t("file.size.stop"), undefined, () => request ? stop(true) : calculate());
    row.append(value, status, control);
    signal.addEventListener('abort', () => request?.abort(), { once: true });
    for (const event of ['offline', 'tuxee-disconnected'])
        window.addEventListener(event, () => { if (request) stop(false); }, { signal });
    if (!signal.aborted) void calculate();
    return row;
}
