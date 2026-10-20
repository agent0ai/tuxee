import { el } from './ui';

export class BackendConnection {
    private events = new AbortController();
    private request?: AbortController;
    private timer?: ReturnType<typeof setTimeout>;
    private dialog?: HTMLDialogElement;
    private verifySession = true;

    constructor(private verify: (signal: AbortSignal) => Promise<void>) {
        const signal = this.events.signal;
        window.addEventListener('tuxee-connection-check', this.check, { signal });
        window.addEventListener('tuxee-connection-lost', () => { this.show(); this.check(); }, { signal });
        window.addEventListener('tuxee-unauthorized', () => { this.verifySession = true; this.check(); }, { signal });
        window.addEventListener('online', this.check, { signal });
        window.addEventListener('offline', () => { this.show(); this.check(); }, { signal });
        window.addEventListener('focus', this.check, { signal });
        document.addEventListener('visibilitychange', () => {
            clearTimeout(this.timer);
            if (!document.hidden) this.check();
        }, { signal });
        this.check();
    }
    private check = async () => {
        if (this.events.signal.aborted || document.hidden || this.request) return;
        clearTimeout(this.timer);
        const request = this.request = new AbortController();
        const timeout = setTimeout(() => request.abort(), 4000);
        try {
            const response = await fetch('/health', { cache: 'no-store', signal: request.signal });
            if (!response.ok || await response.text() !== 'ok') throw new Error('Backend unavailable');
            if (this.verifySession) {
                await this.verify(request.signal);
                request.signal.throwIfAborted();
                this.verifySession = false;
            }
            if (!this.events.signal.aborted) this.hide();
        } catch {
            this.verifySession = true;
            if (!this.events.signal.aborted && !document.hidden) this.show();
        } finally {
            clearTimeout(timeout);
            this.request = undefined;
            if (!this.events.signal.aborted && !document.hidden)
                this.timer = setTimeout(this.check, this.dialog ? 2000 : 5000);
        }
    };
    private show() {
        this.verifySession = true;
        if (this.dialog || this.events.signal.aborted) return;
        const message = 'Connection lost, reconnecting...';
        const dialog = this.dialog = el('dialog', 'modal connection-overlay');
        dialog.setAttribute('aria-label', message);
        dialog.oncancel = event => event.preventDefault();
        const spinner = el('span', 'connection-spinner'), status = el('p', '', message);
        spinner.setAttribute('aria-hidden', 'true');
        status.setAttribute('role', 'status');
        dialog.append(spinner, status);
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
