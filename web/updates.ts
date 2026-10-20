import { api, button, el, icon } from './ui';

type Status = { current: string; latest?: string; available: boolean; checkedAt: string; error?: string; command: string };

export class Updates {
    private status?: Status;
    private timer?: ReturnType<typeof setTimeout>;
    private request?: AbortController;
    private events = new AbortController();
    private listeners = new Set<() => void>();
    constructor(private changed: () => void) {
        document.addEventListener('visibilitychange', () => this.poll(), { signal: this.events.signal });
        window.addEventListener('focus', () => this.poll(), { signal: this.events.signal });
        void this.poll();
    }
    get warning() { return this.status?.available ? `Tuxee ${this.status.latest} is available` : ''; }
    private publish(status: Status) {
        this.status = status; this.changed(); this.listeners.forEach(listener => listener());
    }
    private async poll() {
        clearTimeout(this.timer); this.request?.abort();
        if (document.hidden || this.events.signal.aborted) return;
        const request = this.request = new AbortController();
        try {
            const status = await api<Status>('/update', 'GET', undefined, request.signal);
            if (!request.signal.aborted) this.publish(status);
        } catch { /* Keep the last notice; connection.ts owns server outages. */ }
        finally {
            if (!request.signal.aborted) this.timer = setTimeout(() => this.poll(), 60000);
        }
    }
    view(signal: AbortSignal) {
        const content = el('tr', 'about-update'), cell = el('td'), summary = el('div', 'update-summary');
        content.setAttribute('aria-label', 'Updates'); cell.colSpan = 2;
        const message = el('span', 'update-status'), checked = el('span', 'update-checked muted'), detail = el('p', 'update-error');
        const command = el('code', 'update-command'), restart = el('p', 'muted', 'The update takes effect on restart. Restarting ends all terminal sessions.');
        const checkLabel = el('span', '', 'Check now');
        const check = button('Check now', 'RefreshCw', async () => {
            check.disabled = true; checkLabel.textContent = 'Checking…'; detail.hidden = true;
            content.setAttribute('aria-busy', 'true');
            try {
                const status = await api<Status>('/update', 'POST', undefined, signal);
                if (!signal.aborted) this.publish(status);
            } catch (error) {
                if (!signal.aborted) {
                    detail.textContent = error instanceof Error ? error.message : 'Unable to check for updates';
                    detail.hidden = false;
                }
            } finally { check.disabled = false; checkLabel.textContent = 'Check now'; content.removeAttribute('aria-busy'); }
        });
        check.append(checkLabel);
        message.setAttribute('role', 'status'); detail.setAttribute('role', 'status');
        summary.append(message, checked, check);
        cell.append(summary, detail, command, restart); content.append(cell);
        const dateFormat = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
        const paint = () => {
            const status = this.status;
            content.classList.toggle('update-available', !!status?.available);
            message.replaceChildren();
            if (status?.available) {
                const badge = el('span', 'menu-warning'); badge.append(icon('TriangleAlert'));
                message.append(badge, document.createTextNode(`${status.latest} available`));
            } else message.textContent = status?.error ? 'Check failed' : status?.latest ? 'Up to date' : 'Not checked';
            checked.hidden = !status || status.checkedAt.startsWith('0001-');
            checked.textContent = checked.hidden ? '' : `checked ${dateFormat.format(new Date(status!.checkedAt)).replace(',', '')}`;
            detail.hidden = !status?.error;
            detail.textContent = status?.error ? `Check failed: ${status.error}` : '';
            command.hidden = restart.hidden = !status?.available;
            command.textContent = status?.command || '';
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
