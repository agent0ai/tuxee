import { locale, t, errorText } from './i18n';
import { api, button, el, icon } from './ui';

type Status = { current: string; latest?: string; available: boolean; checkedAt: string; error?: string; command: string; canApply: boolean; restartNeeded: boolean; installing: boolean };

export class Updates {
    private status?: Status;
    private applying = false;
    private applyError = "";
    private timer?: ReturnType<typeof setTimeout>;
    private request?: AbortController;
    private events = new AbortController();
    private listeners = new Set<() => void>();
    constructor(private changed: () => void, private prepare: () => Promise<boolean>) {
        document.addEventListener('visibilitychange', () => this.poll(), { signal: this.events.signal });
        window.addEventListener('focus', () => this.poll(), { signal: this.events.signal });
        void this.poll();
    }
    get warning() { return this.status?.available ? t("updates.available", { version: this.status.latest }) : ''; }
    private publish(status: Status) {
        this.status = status; this.changed(); this.listeners.forEach(listener => listener());
    }
    private async poll() {
        clearTimeout(this.timer); this.request?.abort();
        if (document.hidden || this.events.signal.aborted || this.applying) return;
        const request = this.request = new AbortController();
        try {
            const status = await api<Status>('/update', 'GET', undefined, request.signal);
            if (!request.signal.aborted && !this.applying) this.publish(status);
        } catch { /* Keep the last notice; connection.ts owns server outages. */ }
        finally {
            if (!request.signal.aborted) this.timer = setTimeout(() => this.poll(), 60000);
        }
    }
    private async apply() {
        if (this.applying) return;
        this.applying = true; this.applyError = '';
        this.request?.abort();
        this.listeners.forEach(listener => listener());
        let restarting = false;
        try {
            if (!await this.prepare()) return;
            await api('/update/apply', 'POST', undefined, this.events.signal);
            restarting = true;
            window.dispatchEvent(new Event('tuxee-connection-lost'));
        } catch (error) {
            if (!this.events.signal.aborted) this.applyError = t('updates.installFailed', { detail: errorText(error as Error) });
        } finally {
            if (!restarting) {
                this.applying = false;
                this.listeners.forEach(listener => listener());
                void this.poll();
            }
        }
    }
    view(signal: AbortSignal) {
        const content = el('tr', 'about-update'), cell = el('td'), summary = el('div', 'update-summary');
        content.setAttribute('aria-label', t("updates.updates")); cell.colSpan = 2;
        const message = el('span', 'update-status'), checked = el('span', 'update-checked muted'), detail = el('p', 'update-error');
        const subtitle = el('p', 'update-subtitle muted'), actions = el('span', 'update-actions');
        const install = button(t('updates.install'), 'Download', () => this.apply(), 'primary update-install');
        const installLabel = el('span'); install.append(installLabel);
        const checkLabel = el('span');
        let checking = false, checkError = '';
        const check = button(t("updates.checkNow"), 'RefreshCw', async () => {
            checking = true; checkError = ''; paint();
            try {
                const status = await api<Status>('/update', 'POST', undefined, signal);
                if (!signal.aborted) this.publish(status);
            } catch (error) {
                if (!signal.aborted) checkError = errorText(error as Error);
            } finally { checking = false; paint(); }
        });
        check.append(checkLabel);
        message.setAttribute('role', 'status'); detail.setAttribute('role', 'status');
        actions.append(install, check); summary.append(message, checked, actions);
        cell.append(summary, detail, subtitle); content.append(cell);
        const dateFormat = new Intl.DateTimeFormat(locale() === 'en' ? 'de-DE' : locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
        const paint = () => {
            const status = this.status, busy = this.applying || !!status?.installing;
            content.classList.toggle('update-available', !!status?.available);
            content.setAttribute('aria-busy', String(busy || checking));
            message.replaceChildren();
            if (status?.available) {
                const badge = el('span', 'menu-warning'); badge.append(icon('TriangleAlert'));
                message.append(badge, document.createTextNode(t("updates.versionAvailable", { version: status.latest })));
            } else message.textContent = status?.restartNeeded ? t('updates.restartRequired') : status?.error ? t("updates.checkFailed") : status?.latest ? t("updates.upToDate") : t("updates.notChecked");
            checked.hidden = !status || status.checkedAt.startsWith('0001-');
            checked.textContent = checked.hidden ? '' : t("updates.checked", { date: dateFormat.format(new Date(status!.checkedAt)).replace(',', '') });
            install.hidden = !status?.available || !status.canApply;
            install.disabled = check.disabled = busy || checking;
            installLabel.textContent = busy ? t('updates.installing') : t('updates.install');
            checkLabel.hidden = !!status?.available;
            checkLabel.textContent = checking ? t('updates.checking') : t('updates.checkNow');
            check.title = checking ? t('updates.checking') : t('updates.checkNow');
            check.setAttribute('aria-label', check.title);
            detail.textContent = this.applyError || checkError || (status?.error ? t("updates.failureDetail", { detail: errorText(status) }) : '');
            detail.hidden = !detail.textContent;
            subtitle.hidden = !status?.available;
            subtitle.replaceChildren();
            if (status?.canApply) {
                t('updates.manualCommand', { command: '\uFFFC' }).split('\uFFFC').forEach((part, index) => {
                    if (index) { const command = el('code', '', status.command); command.dir = 'ltr'; subtitle.append(command); }
                    subtitle.append(document.createTextNode(part));
                });
            } else subtitle.textContent = t('updates.contactAdministrator');
        };
        this.listeners.add(paint);
        signal.addEventListener('abort', () => this.listeners.delete(paint), { once: true });
        paint();
        return content;
    }
    dispose() {
        this.events.abort(); this.request?.abort(); clearTimeout(this.timer); this.listeners.clear();
    }
}
