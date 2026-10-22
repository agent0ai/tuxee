import { TerminalDisplay } from './display';
import { Terminal } from '@xterm/xterm';
import { installTerminalView, installTerminalMetrics, installTerminalUnicode, terminalDimensions, restoreTerminal, terminalTheme } from './terminal/state';
import { installTerminalTouch } from './terminal/interaction';
import { api, APIError, button, el, notify, ask } from './ui';
import { registerFileDrop, registerUploadInput, setDropFeedback, shellPaths, animateFileDrop } from './file-drag';
import { uploadBatch, type UploadSource } from './transfers';
import { join, type Panel, type Hooks, type View, type TerminalInfo } from './model';
const creating = new Map<string, Promise<TerminalInfo>>();
export async function terminateTerminal(panel: Panel) {
    await creating.get(panel.id);
    if (!panel.terminal) return;
    try { await api(`/terminals/${panel.terminal}`, 'DELETE'); }
    catch (error) { if (!(error instanceof APIError && error.status === 404)) throw error; }
}

export class TerminalView implements View {
    readonly term: Terminal;
    private display: TerminalDisplay;
    private socket?: WebSocket;
    private disposed = false;
    private controller = false;
    private ready = false;
    private ended = false;
    private attempt = 0;
    private reconnect?: ReturnType<typeof setTimeout>;
    private resizeTimer?: ReturnType<typeof setTimeout>;
    private observer: ResizeObserver;
    private queue: Uint8Array[] = [];
    private pendingBytes = 0;
    private inFlight = false;
    private starting: Promise<void>;
    private closing = false;
    private events = new AbortController();
    private control = button('Take control', 'Hand', () => this.sendControl({ type: 'take-control' }));
    private name = 'Terminal';
    private host = el('div', 'terminal-host');
    constructor(private root: HTMLElement, private panel: Panel, private hooks: Hooks) {
        root.classList.add('terminal-view');
        this.term = new Terminal({ allowProposedApi: true, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 13, lineHeight: 1, cursorBlink: true, scrollback: 2000, theme: terminalTheme });
        installTerminalUnicode(this.term);
        this.control.hidden = true;
        const controls = root.closest('.panel')!.querySelector('.panel-tools')!;
        controls.prepend(this.control);
        root.append(this.host);
        const dropTarget = root.closest<HTMLElement>('.panel')!;
        registerFileDrop(dropTarget, {
            over: () => { const accepted = this.ready && this.controller && !this.ended; setDropFeedback(root, accepted ? 'Paste' : undefined); return accepted; },
            leave: () => setDropFeedback(root),
            drop: drop => { this.term.paste(shellPaths(drop.files)); this.term.focus(); animateFileDrop(drop.files, drop, this.host); }
        }, this.events.signal);
        registerUploadInput(dropTarget, {
            accept: () => this.canUpload(),
            over: () => setDropFeedback(root, 'Upload and paste'),
            leave: () => setDropFeedback(root),
            upload: (sources, point) => { void this.uploadFiles(sources, point); }
        }, this.events.signal);
        this.term.open(this.host);
        installTerminalView(this.term);
        installTerminalMetrics(this.term);
        installTerminalTouch(this.term, this.events.signal);
        this.display = new TerminalDisplay(root, this.host, () => this.panel.terminal, () => { this.resize(); this.term.focus(); });
        this.term.onData(data => this.input(data));
        this.term.onBinary(data => this.inputBytes(Uint8Array.from(data, c => c.charCodeAt(0))));
        this.observer = new ResizeObserver(() => this.resize());
        this.observer.observe(this.host);
        this.starting = this.start().catch(error => { this.state('unavailable'); this.notice(error); });
    }
    private notice = (value: unknown) => notify(value, this.root);
    private canUpload() { return this.ready && this.controller && !this.ended && !this.disposed && !this.closing; }
    private async uploadFiles(sources: UploadSource[], point?: { clientX: number; clientY: number }) {
        this.term.focus();
        let uploaded;
        try { uploaded = await uploadBatch(join(this.hooks.user.home, 'uploads'), sources, this.root, this.events.signal, true); }
        catch { return; } // The batch indicator owns upload errors and cancellation.
        if (!this.canUpload()) {
            if (!this.disposed) this.notice('Uploaded to ~/uploads; terminal no longer accepts input');
            return;
        }
        if (!uploaded.length) return;
        this.term.paste(shellPaths(uploaded));
        if (point) animateFileDrop(uploaded, point, this.host);
    }
    private state(value: string) { this.root.dataset.state = value; }
    private sessionLost() {
        if (this.disposed || this.closing) return;
        this.ended = true; this.ready = false; this.control.hidden = true;
        this.state('ended');
        this.display.update();
        clearTimeout(this.reconnect);
        const socket = this.socket; this.socket = undefined; socket?.close();
        this.root.querySelector('.terminal-recovery')?.remove();
        this.host.hidden = true;
        this.root.classList.add('session-lost');
        const recovery = el('div', 'terminal-recovery'), message = el('p', '', 'Terminal session lost');
        message.setAttribute('role', 'status');
        const lost = this.panel.terminal;
        const restart = button('Restart terminal', undefined, () => {
            restart.disabled = true;
            if (this.panel.terminal === lost) delete this.panel.terminal;
            this.ended = false;
            this.term.reset();
            this.starting = (async () => {
                // Retry a failed save without abandoning the replacement shell.
                if (this.panel.terminal) await this.hooks.changed(true);
                await this.start();
                if (this.ended || this.disposed || this.closing) return;
                recovery.remove(); this.root.classList.remove('session-lost');
                this.host.hidden = false;
            })().catch(error => { this.ended = true; this.notice(error); }).finally(() => { restart.disabled = false; });
        }, 'primary restart-terminal');
        recovery.append(message, restart);
        this.root.append(recovery);
    }
    private async start() {
        let info: TerminalInfo;
        if (this.panel.terminal) {
            try {
                info = await api(`/terminals/${this.panel.terminal}`);
            }
            catch (error) {
                if (this.disposed)
                    return;
                if (!(error instanceof APIError) || error.status !== 404)
                    throw error;
                this.sessionLost();
                return;
            }
        }
        else {
            let pending = creating.get(this.panel.id);
            if (!pending) {
                pending = api<TerminalInfo>('/terminals', 'POST', { directory: this.panel.path, name: 'Terminal', columns: 80, rows: 24 }).then(async (value) => { this.panel.terminal = value.id; await this.hooks.changed(true); return value; }).finally(() => creating.delete(this.panel.id));
                creating.set(this.panel.id, pending);
            }
            info = await pending;
        }
        this.name = info.name;
        this.hooks.title?.(info.name); this.display.rename(info.name);
        this.root.dataset.terminal = info.id;
        if (!this.disposed && !this.closing)
            this.connect();
    }
    private connect() {
        if (this.disposed || this.closing || !this.panel.terminal)
            return;
        this.ready = false;
        this.controller = false;
        this.queue = [];
        this.pendingBytes = 0;
        this.inFlight = false;
        this.state('connecting');
        const ws = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminals/${this.panel.terminal}/ws`);
        let chain = Promise.resolve();
        ws.onmessage = event => {
            chain = chain.then(async () => {
                if (this.disposed || this.socket !== ws)
                    return;
                const value = JSON.parse(event.data);
                if (value.type === 'ack') {
                    this.inFlight = false;
                    this.flushInput();
                    return;
                }
                switch (value.type) {
                    case 'display':
                        this.display.update(value.display);
                        break;
                    case 'snapshot':
                        this.display.update(value.display);
                        restoreTerminal(this.term, value.snapshot);
                        this.ready = true;
                        this.controller = value.control;
                        this.attempt = 0;
                        this.resize();
                        break;
                    case 'data':
                        await new Promise<void>(resolve => this.term.write(Uint8Array.from(atob(value.data), c => c.charCodeAt(0)), resolve));
                        break;
                    case 'resize':
                        this.term.resize(value.columns, value.rows);
                        break;
                    case 'control':
                        this.controller = value.control;
                        if (this.controller)
                            this.resize();
                        break;
                    case 'exit':
                        this.display.update();
                        this.ended = true;
                        this.state('ended');
                        break;
                    case 'closed':
                        this.sessionLost();
                        break;
                    case 'error':
                        this.inFlight = false;
                        this.queue = [];
                        this.pendingBytes = 0;
                        this.notice(value.message);
                        break;
                }
                if (!this.ended)
                    this.state(this.controller ? 'connected' : 'viewing');
                this.control.hidden = this.controller || this.ended;
                this.root.classList.toggle('read-only', !this.controller);
                if (value.sequence)
                    this.sendControl({ type: 'rendered', sequence: value.sequence });
            }).catch(error => { this.notice(error); ws.close(); });
        };
        ws.onclose = () => {
            if (this.disposed || this.socket !== ws)
                return;
            this.ready = false;
            if (this.ended) {
                this.state('ended');
                return;
            }
            if (!this.closing) window.dispatchEvent(new Event('tuxee-connection-check'));
            this.state('disconnected');
            this.reconnect = setTimeout(async () => {
                try {
                    await api(`/terminals/${this.panel.terminal}`);
                    this.connect();
                }
                catch (error) {
                    if (this.disposed)
                        return;
                    if (error instanceof APIError && error.status === 404) {
                        this.sessionLost();
                    }
                    else {
                        this.state('unavailable');
                        this.reconnect = setTimeout(() => this.connect(), 15000);
                    }
                }
            }, Math.min(1000 * 2 ** this.attempt++, 15000));
        };
    }
    private sendControl(value: object) { if (this.socket?.readyState === WebSocket.OPEN)
        this.socket.send(JSON.stringify(value)); }
    private input(data: string) { this.inputBytes(new TextEncoder().encode(data)); }
    private inputBytes(data: Uint8Array) {
        if (!this.ready || !this.controller || this.ended)
            return;
        if (this.pendingBytes + data.length > 256 * 1024) {
            this.notice('Input is busy; wait before pasting more');
            return;
        }
        for (let i = 0; i < data.length; i += 32768)
            this.queue.push(data.slice(i, i + 32768));
        this.pendingBytes += data.length;
        this.flushInput();
    }
    private flushInput() { if (this.inFlight || this.socket?.readyState !== WebSocket.OPEN)
        return; const value = this.queue.shift(); if (value) {
        this.pendingBytes -= value.length;
        this.inFlight = true;
        this.socket.send(value);
    } }
    resize = () => { this.display?.resize(); clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.fitSize(), 80); };
    private fitSize() {
        if (this.disposed || !this.host.isConnected || this.host.clientWidth < 30 || this.host.clientHeight < 30)
            return;
        this.term.refresh(0, this.term.rows - 1);
        if (!this.ready || !this.controller)
            return;
        const proposed = terminalDimensions(this.term);
        if (proposed) {
            const columns = Math.max(2, Math.min(500, proposed.cols)), rows = Math.max(1, Math.min(200, proposed.rows));
            if (this.term.cols !== columns || this.term.rows !== rows)
                this.sendControl({ type: 'resize', columns, rows });
        }
    }
    async renamePanel() {
        const name = await ask('Rename terminal', 'Name', this.name, 'Terminal');
        if (!name) return;
        await this.starting;
        const info = await api<TerminalInfo>(`/terminals/${this.panel.terminal}`, 'PATCH', { name });
        this.name = info.name; this.hooks.title?.(info.name); this.display.rename(info.name);
    }
    async close() {
        this.closing = true; this.socket?.close();
        await this.starting;
        await terminateTerminal(this.panel);
        this.ended = true; this.state('ended');
    }
    dispose() { this.disposed = true; this.events.abort(); this.control.remove(); clearTimeout(this.reconnect); clearTimeout(this.resizeTimer); this.socket?.close(); this.observer.disconnect(); this.display.dispose(); this.term.dispose(); }
}
