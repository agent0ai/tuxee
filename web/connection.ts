import { api, el, requestHeaders } from './ui';

type ConnectionState = { authenticated: false } | { authenticated: true; uid: number; csrf: string };

export class BackendConnection {
    private events = new AbortController();
    private request?: AbortController;
    private timer?: ReturnType<typeof setTimeout>;
    private dialog?: HTMLDialogElement;

    constructor(private restore: (session: { uid: number; csrf: string }, signal: AbortSignal) => Promise<void>, private expired: () => void) {
        const signal = this.events.signal;
        window.addEventListener('tuxee-connection-check', this.check, { signal });
        window.addEventListener('tuxee-connection-lost', this.lost, { signal });
        window.addEventListener('tuxee-unauthorized', this.check, { signal });
        window.addEventListener('online', this.check, { signal });
        window.addEventListener('offline', this.lost, { signal });
        window.addEventListener('focus', this.check, { signal });
        document.addEventListener('visibilitychange', () => {
            clearTimeout(this.timer);
            if (!document.hidden) this.check();
        }, { signal });
        this.check();
    }
    private lost = () => {
        this.show();
        this.request?.abort();
        this.check();
    };
    private check = async () => {
        if (this.events.signal.aborted || document.hidden || this.request) return;
        clearTimeout(this.timer);
        const request = this.request = new AbortController();
        const token = requestHeaders()['X-Tuxee-CSRF'];
        const timeout = setTimeout(() => request.abort(), 4000);
        try {
            const state = await api<ConnectionState>('/connection', 'GET', undefined, request.signal);
            if (typeof state?.authenticated !== 'boolean' || state.authenticated &&
                (!Number.isInteger(state.uid) || state.uid < 0 || typeof state.csrf !== 'string' || !state.csrf)) throw new Error('Invalid connection state');
            if (token !== requestHeaders()['X-Tuxee-CSRF']) return;
            request.signal.throwIfAborted();
            if (state.authenticated) await this.restore(state, request.signal);
            request.signal.throwIfAborted();
            if (this.events.signal.aborted) return;
            if (!state.authenticated) this.expired();
            this.hide();
        } catch {
            if (!this.events.signal.aborted && !document.hidden) this.show();
        } finally {
            clearTimeout(timeout);
            this.request = undefined;
            if (!this.events.signal.aborted && !document.hidden)
                this.timer = setTimeout(this.check, this.dialog ? 2000 : 5000);
        }
    };
    private show() {
        if (this.dialog || this.events.signal.aborted) return;
        const message = 'Connection lost, reconnecting...';
        const dialog = this.dialog = el('dialog', 'modal connection-overlay');
        dialog.setAttribute('aria-label', message);
        dialog.oncancel = event => event.preventDefault();
        const progress = el('span', 'connection-progress'), status = el('p', '', message);
        progress.setAttribute('aria-hidden', 'true');
        status.setAttribute('role', 'status');
        dialog.append(status, progress);
        document.body.append(dialog);
        dialog.showModal();
    }
    private hide() {
        this.dialog?.close();
        this.dialog?.remove();
        this.dialog = undefined;
    }
    dispose() {
        this.events.abort();
        clearTimeout(this.timer);
        this.request?.abort();
        this.hide();
    }
}
