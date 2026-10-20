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
        const content = el('section', 'about-update'), message = el('p'), detail = el('p', 'muted');
        const command = el('code', 'update-command'), restart = el('p', 'muted', 'The update takes effect on restart. Restarting ends all terminal sessions.');
        const check = button('Check for updates', 'RefreshCw', async () => {
            check.disabled = true; detail.textContent = 'Checking…';
            try {
                const status = await api<Status>('/update', 'POST', undefined, signal);
                if (!signal.aborted) this.publish(status);
            } catch (error) {
                if (!signal.aborted) detail.textContent = error instanceof Error ? error.message : 'Unable to check for updates';
            } finally { check.disabled = false; }
        });
        check.append(el('span', '', 'Check for updates'));
        message.setAttribute('role', 'status'); detail.setAttribute('role', 'status');
        content.append(message, check, detail, command, restart);
        const paint = () => {
            const status = this.status;
            message.replaceChildren();
            if (status?.available) {
                const badge = el('span', 'menu-warning'); badge.append(icon('TriangleAlert'));
                message.append(badge, document.createTextNode(` Tuxee ${status.latest} is available`));
            } else message.textContent = status?.latest ? 'No newer stable release' : 'Update status unavailable';
            detail.textContent = status?.error
                ? `Check failed: ${status.error}`
                : status && !status.checkedAt.startsWith('0001-') ? `Last checked: ${new Date(status.checkedAt).toLocaleString()}` : '';
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
