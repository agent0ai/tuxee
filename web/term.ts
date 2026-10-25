import { TerminalDisplay } from './display';
import { Terminal } from '@xterm/xterm';
import { installTerminalView, installTerminalMetrics, installTerminalUnicode, installTerminalResize, terminalDimensions, restoreTerminal, terminalTheme, retainedScrollback, MAX_SNAPSHOT_BYTES } from './terminal/state';
import { installTerminalTouch } from './terminal/interaction';
import { api, APIError, button, el, notify, ask, popover } from './ui';
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
    private inFlight: number[] = [];
    private displayQueue = Promise.resolve();
    private displayWrites = new Set<Promise<void>>();
    private resizeDisplay: ReturnType<typeof installTerminalResize>;
    private uncertainInput = false;
    private resizing = false;
    private lastSize = '';
    private starting: Promise<void>;
    private closing = false;
    private events = new AbortController();
    private control = button('Take control', 'Hand', () => this.sendControl({ type: 'take-control' }));
    private name = 'Terminal';
    private surface = el('div', 'terminal-surface');
    private host = el('div', 'terminal-host');
    private closeText = () => {};
    private rendering = el('div', 'terminal-rendering', 'Loading...');
    private renderingStarted = performance.now();
    private renderingTimer?: ReturnType<typeof setTimeout>;
    constructor(private root: HTMLElement, private panel: Panel, private hooks: Hooks) {
        root.classList.add('terminal-view');
        this.term = new Terminal({ allowProposedApi: true, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 13, lineHeight: 1, cursorBlink: true, disableStdin: true, scrollback: retainedScrollback(80, 24),
            theme: { ...terminalTheme, selectionBackground: '#58a6ff9e', selectionInactiveBackground: '#58a6ff6b' },
            linkHandler: { activate: (_event, uri) => { window.open(uri, '_blank', 'noopener,noreferrer'); } } });
        installTerminalUnicode(this.term);
        this.control.append(el('span', '', 'Control'));
        this.control.hidden = true;
        const controls = root.closest('.panel')!.querySelector('.panel-tools')!;
        controls.prepend(this.control);
        root.append(this.surface);
        this.surface.append(this.host);
        const dropTarget = root.closest<HTMLElement>('.panel')!;
        registerFileDrop(dropTarget, {
            over: () => { const accepted = this.canDrop(); setDropFeedback(root, accepted ? this.display?.visible ? 'Drop files' : 'Paste' : undefined); return accepted; },
            leave: () => setDropFeedback(root),
            drop: drop => {
                if (this.display.visible) {
                    try { void this.display.dropFiles(drop.files, this.display.dropTarget(drop)).catch(this.notice); } catch (error) { this.notice(error); }
                } else { this.term.paste(shellPaths(drop.files)); this.term.focus(); animateFileDrop(drop.files, drop, this.host); }
            }
        }, this.events.signal);
        registerUploadInput(dropTarget, {
            accept: () => this.canDrop(),
            over: () => setDropFeedback(root, this.display?.visible ? 'Upload and drop' : 'Upload and paste'),
            leave: () => setDropFeedback(root),
            upload: (sources, point) => { void this.uploadFiles(sources, point); }
        }, this.events.signal);
        this.term.open(this.host);
        installTerminalView(this.term);
        installTerminalMetrics(this.term);
        this.resizeDisplay = installTerminalResize(this.term);
        for (const event of ['pointerdown', 'wheel']) this.host.addEventListener(event, () => this.resizeDisplay.release(), { signal: this.events.signal, passive: true });
        const scroll = (top: boolean) => {
            this.resizeDisplay.release();
            if (top) this.term.scrollToTop(); else this.term.scrollToBottom();
            this.term.focus();
        };
        const top = button('Jump to top', 'ArrowUp', () => scroll(true));
        const bottom = button('Jump to bottom', 'ArrowDown', () => scroll(false));
        const updateScroll = () => {
            const buffer = this.term.buffer.active;
            top.disabled = buffer.type !== 'normal' || buffer.viewportY === 0;
            bottom.disabled = buffer.type !== 'normal' || buffer.viewportY === buffer.baseY;
        };
        const drawer = el('textarea', 'terminal-input');
        drawer.rows = 5; drawer.hidden = true; drawer.spellcheck = false;
        drawer.setAttribute('autocapitalize', 'off'); drawer.setAttribute('autocorrect', 'off');
        drawer.setAttribute('aria-label', 'Terminal input drawer');
        drawer.placeholder = 'Enter: paste and send · Shift+Enter: new line · Ctrl/Cmd+Enter: paste only';
        const toggle = button('Toggle terminal input', 'TextCursorInput', () => {
            drawer.hidden = !drawer.hidden;
            toggle.setAttribute('aria-expanded', String(!drawer.hidden));
            if (drawer.hidden) this.term.focus(); else drawer.focus();
        });
        toggle.setAttribute('aria-expanded', 'false');
        drawer.onkeydown = event => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
            event.preventDefault(); event.stopPropagation();
            if (!this.canUpload()) { this.notice('Terminal is not ready for input'); return; }
            // Queue paste and Enter atomically so a rejected paste can never execute a partial command.
            let data = drawer.value.replace(/\r?\n/g, '\r');
            if (this.term.modes.bracketedPasteMode && data) data = '\x1b[200~' + data + '\x1b[201~';
            if (!event.ctrlKey && !event.metaKey) data += '\r';
            if (this.input(data)) { drawer.value = ''; this.term.scrollToBottom(); }
        };
        const text = button('Terminal contents as text', undefined, () => this.showText(text));
        text.textContent = 'T'; text.setAttribute('aria-haspopup', 'dialog'); text.setAttribute('aria-expanded', 'false');
        const footer = el('div', 'terminal-footer'), left = el('div'), right = el('div');
        left.append(toggle, text);
        right.append(button('Reconnect terminal', 'RefreshCw', () => this.connect()), top, bottom);
        footer.append(left, right); this.surface.append(drawer, footer);
        updateScroll();
        this.rendering.setAttribute('role', 'status');
        this.host.append(this.rendering);
        this.term.onScroll(updateScroll);
        this.term.onRender(() => {
            updateScroll();
            if (this.ready && this.rendering.isConnected && !this.renderingTimer) {
                // Keep even a fast reconnect visible without delaying recovery or input.
                this.renderingTimer = setTimeout(() => {
                    this.renderingTimer = undefined;
                    if (this.ready) this.rendering.remove();
                }, Math.max(0, 200 - (performance.now() - this.renderingStarted)));
            }
        });
        installTerminalTouch(this.term, this.events.signal);
        this.display = new TerminalDisplay(root, this.surface, () => this.panel.terminal, () => { this.resize(); this.term.focus(); }, this.hooks.user);
        this.term.onData(data => this.input(data));
        this.term.onBinary(data => this.input(data, true));
        this.term.attachCustomKeyEventHandler(event => {
            if (event.key !== 'Enter' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return true;
            // shortcut: CSI-u for Shift+Enter only; broader keyboard modes need shared engine support.
            event.preventDefault(); event.stopPropagation();
            if (event.type === 'keydown') this.term.input('\x1b[13;2u');
            return false;
        });
        this.observer = new ResizeObserver(() => { this.closeText(); this.resize(); });
        this.observer.observe(this.host);
        this.starting = this.start().catch(error => { this.state('unavailable'); this.notice(error); });
    }
    private showText(anchor: HTMLElement) {
        if (anchor.getAttribute('aria-expanded') === 'true') { this.closeText(); return; }
        this.closeText();
        const content = el('div', 'terminal-text'), text = el('textarea');
        content.setAttribute('role', 'dialog'); content.setAttribute('aria-label', 'Terminal contents');
        const rect = this.host.getBoundingClientRect();
        content.style.width = `${rect.width}px`; content.style.height = `${rect.height}px`;
        const style = getComputedStyle(this.term.element!);
        const rows = getComputedStyle(this.term.element!.querySelector('.xterm-rows')!);
        Object.assign(text.style, { fontFamily: rows.fontFamily, fontSize: rows.fontSize, lineHeight: rows.lineHeight, letterSpacing: rows.letterSpacing, fontVariantLigatures: rows.fontVariantLigatures });
        text.style.padding = style.padding;
        text.readOnly = true; text.spellcheck = false; text.wrap = 'soft';
        text.setAttribute('aria-label', 'Terminal contents as text');
        text.onkeydown = event => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
                event.preventDefault(); event.stopPropagation(); text.select();
            }
        };
        const buffer = this.term.buffer.active, lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i)!;
            const value = line.translateToString(true);
            if (line.isWrapped && lines.length) lines[lines.length - 1] += value;
            else lines.push(value);
        }
        text.value = lines.join('\n').trimEnd();
        content.append(text);
        ({ close: this.closeText } = popover(anchor, content));
        content.style.left = `${rect.left}px`; content.style.top = `${rect.top}px`;
        text.focus();
    }
    private notice = (value: unknown) => notify(value, this.root);
    private canUpload() { return this.ready && this.controller && !this.ended && !this.disposed && !this.closing; }
    private canDrop() { return this.display?.visible ? this.display.connected && !this.disposed && !this.closing : this.canUpload(); }
    private async uploadFiles(sources: UploadSource[], point?: { clientX: number; clientY: number }) {
        let target: ReturnType<TerminalDisplay['dropTarget']> | undefined;
        if (this.display.visible) {
            try { target = this.display.dropTarget(point); } catch (error) { this.notice(error); return; }
        } else this.term.focus();
        let uploaded;
        try { uploaded = await uploadBatch(join(this.hooks.user.home, 'uploads'), sources, this.root, this.events.signal, true); }
        catch { return; } // The batch indicator owns upload errors and cancellation.
        if (!uploaded.length) return;
        if (target) { try { await this.display.dropFiles(uploaded, target); } catch (error) { this.notice(error); } return; }
        if (!this.canUpload()) {
            if (!this.disposed) this.notice('Uploaded to ~/uploads; terminal no longer accepts input');
            return;
        }
        if (this.display.visible) { this.notice('Uploaded to ~/uploads; terminal is no longer visible'); return; }
        this.term.paste(shellPaths(uploaded));
        if (point) animateFileDrop(uploaded, point, this.host);
    }
    private state(value: string) {
        if (value !== 'connected' && value !== 'viewing') this.resizeDisplay.release();
        this.root.dataset.state = value;
        this.term.options.disableStdin = !this.canUpload();
        this.control.hidden = !this.ready || this.controller || this.ended;
        this.root.classList.toggle('read-only', !this.controller);
    }
    private discardInput() {
        this.uncertainInput ||= this.pendingBytes > 0;
        this.queue = []; this.pendingBytes = 0; this.inFlight = [];
    }
    private sessionLost() {
        if (this.disposed || this.closing) return;
        this.ended = true; this.ready = false; this.control.hidden = true;
        this.state('ended');
        this.display.update();
        clearTimeout(this.reconnect);
        const socket = this.socket; this.socket = undefined; socket?.close();
        this.root.querySelector('.terminal-recovery')?.remove();
        this.surface.hidden = true;
        this.root.classList.add('session-lost');
        const recovery = el('div', 'terminal-recovery'), message = el('p', '', 'Terminal session lost');
        message.setAttribute('role', 'status');
        const lost = this.panel.terminal;
        const restart = button('Restart terminal', undefined, () => {
            restart.disabled = true;
            if (this.panel.terminal === lost) delete this.panel.terminal;
            this.ended = false;
            this.starting = (async () => {
                // Retry a failed save without abandoning the replacement shell.
                if (this.panel.terminal) await this.hooks.changed(true);
                await this.start();
                if (this.ended || this.disposed || this.closing) return;
                recovery.remove(); this.root.classList.remove('session-lost');
                this.surface.hidden = false;
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
        clearTimeout(this.reconnect);
        const previous = this.socket; this.socket = undefined; previous?.close();
        this.ready = false;
        this.closeText();
        clearTimeout(this.renderingTimer); this.renderingTimer = undefined;
        this.renderingStarted = performance.now();
        this.rendering.style.backgroundColor = getComputedStyle(this.term.element!).backgroundColor;
        this.host.append(this.rendering);
        this.controller = false;
        this.discardInput();
        this.resizing = false; this.lastSize = '';
        this.state('connecting');
        const ws = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminals/${this.panel.terminal}/ws`);
        ws.binaryType = 'arraybuffer';
        let received = 0, queuedBytes = 0, queuedFrames = 0;
        const current = () => !this.disposed && this.socket === ws && ws.readyState === WebSocket.OPEN;
        const failed = (error: unknown) => { if (current()) { this.ready = false; this.state('disconnected'); this.notice(error); ws.close(); } };
        ws.onmessage = event => {
            if (!current()) return;
            try {
                let value, bytes: number;
                if (event.data instanceof ArrayBuffer) {
                    bytes = event.data.byteLength;
                    if (bytes < 9 || bytes > 32776) throw Error('Invalid terminal output frame');
                    value = { type: 'data', sequence: Number(new DataView(event.data).getBigUint64(0)), data: new Uint8Array(event.data, 8) };
                } else {
                    bytes = event.data.length;
                    if (bytes > (received ? 1 << 20 : MAX_SNAPSHOT_BYTES + (1 << 20))) throw Error('Terminal message is too large');
                    value = JSON.parse(event.data);
                    if (!value || typeof value !== 'object') throw Error('Invalid terminal message');
                    if (value.type !== 'snapshot' && bytes > 1 << 20) throw Error('Terminal message is too large');
                }
                const unsequenced = value.type === 'ack' || value.type === 'resize-ack' || (value.type === 'error' && value.sequence === undefined);
                if (!unsequenced) {
                    if (!Number.isSafeInteger(value.sequence) || value.sequence !== received + 1 || (!received && value.type !== 'snapshot'))
                        throw Error('Terminal output is out of order');
                    received = value.sequence;
                }
                switch (value.type) {
                    case 'ack':
                        if (!this.inFlight.length || value.sequence !== undefined) throw Error('Unexpected terminal input acknowledgement');
                        this.pendingBytes -= this.inFlight.shift()!; this.flushInput(); return;
                    case 'resize-ack':
                        if (!this.resizing || value.sequence !== undefined) throw Error('Unexpected terminal resize acknowledgement');
                        this.resizing = false; this.resize(); return;
                    case 'error':
                        this.resizeDisplay.release();
                        if (typeof value.message !== 'string') throw Error('Invalid terminal error');
                        this.discardInput(); this.notice(value.message);
                        if (value.sequence === undefined) return;
                        break;
                    case 'snapshot':
                        if (received !== 1 || typeof value.control !== 'boolean') throw Error('Unexpected terminal snapshot');
                        break;
                    case 'control':
                        if (typeof value.control !== 'boolean') throw Error('Invalid terminal control state');
                        this.controller = value.control;
                        if (!this.controller) {
                            if (this.pendingBytes) this.notice('Control moved; check your last input before continuing');
                            this.uncertainInput ||= this.pendingBytes > 0;
                            this.queue = []; this.pendingBytes = this.inFlight.reduce((sum, bytes) => sum + bytes, 0);
                        } else { this.lastSize = ''; this.resize(); }
                        break;
                    case 'resize':
                        if (!Number.isInteger(value.columns) || value.columns < 2 || value.columns > 500 ||
                            !Number.isInteger(value.rows) || value.rows < 1 || value.rows > 200) throw Error('Invalid terminal size');
                        break;
                    case 'exit': this.ended = true; this.display.update(); break;
                    case 'closed': this.sessionLost(); return;
                    case 'display': break;
                    case 'data':
                        if (!(value.data instanceof Uint8Array)) throw Error('Invalid terminal output frame');
                        break;
                    default: throw Error('Unknown terminal message');
                }
                if (value.type === 'snapshot') bytes = 0; // Recovery has its own size/admission limit.
                queuedBytes += bytes;
                if (++queuedFrames > 512 || queuedBytes > 1 << 20) throw Error('Terminal renderer is falling behind');
                this.state(this.ended ? 'ended' : this.ready ? this.controller ? 'connected' : 'viewing' : 'connecting');
                this.displayQueue = this.displayQueue.then(async () => {
                    if (!current()) return;
                    if (value.type !== 'data') {
                        await Promise.all(this.displayWrites);
                        if (!current()) return;
                    }
                    const rendered = () => {
                        if (!current()) return;
                        this.sendControl({ type: 'rendered', sequence: value.sequence });
                        queuedFrames--; queuedBytes -= bytes;
                        this.state(this.ended ? 'ended' : this.controller ? 'connected' : 'viewing');
                    };
                    switch (value.type) {
                        case 'snapshot':
                            restoreTerminal(this.term, value.snapshot);
                            this.display.update(value.display);
                            this.ready = true; this.controller = value.control; this.attempt = 0;
                            if (this.uncertainInput) {
                                this.notice('Connection restored');
                                this.uncertainInput = false;
                            }
                            break;
                        case 'data': {
                            // Let xterm batch consecutive writes; metadata and recovery remain barriers.
                            const write = new Promise<void>(resolve => this.term.write(value.data, () => { rendered(); resolve(); }));
                            this.displayWrites.add(write);
                            void write.then(() => this.displayWrites.delete(write), error => { this.displayWrites.delete(write); failed(error); });
                            return;
                        }
                        case 'resize':
                            this.resizeDisplay.begin();
                            this.term.options.scrollback = retainedScrollback(value.columns, value.rows);
                            this.term.resize(value.columns, value.rows);
                            break;
                        case 'display': this.display.update(value.display); break;
                    }
                    if (!current()) return;
                    rendered();
                    if (value.type === 'snapshot') this.resize();
                }).catch(failed);
            } catch (error) { failed(error); }
        };
        ws.onclose = () => {
            if (this.disposed || this.socket !== ws)
                return;
            this.socket = undefined; this.ready = false; this.discardInput();
            if (this.ended) {
                this.state('ended');
                return;
            }
            if (!this.closing) window.dispatchEvent(new Event('tuxee-connection-check'));
            this.state('disconnected');
            this.reconnect = setTimeout(async () => {
                try {
                    await api(`/terminals/${this.panel.terminal}`);
                    if (this.socket || this.ended) return;
                    this.connect();
                }
                catch (error) {
                    if (this.disposed || this.closing || this.socket || this.ended)
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
    private sendControl(value: object) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            try { this.socket.send(JSON.stringify(value)); }
            catch { this.socket.close(); }
        }
    }
    private input(data: string, binary = false) {
        if (!this.canUpload() || !data.length) return false;
        this.resizeDisplay.release();
        const available = 256 * 1024 - this.pendingBytes;
        const busy = () => this.notice('Input is busy; wait before pasting more');
        if (data.length > available) { busy(); return false; }
        const bytes = new Uint8Array(Math.min(available, data.length * (binary ? 1 : 3)));
        let length = data.length;
        if (binary) { for (let i = 0; i < length; i++) bytes[i] = data.charCodeAt(i); }
        else {
            const result = new TextEncoder().encodeInto(data, bytes);
            if (result.read !== data.length) { busy(); return false; }
            length = result.written;
        }
        if (this.queue.length + this.inFlight.length + Math.ceil(length / 65536) > 512) { busy(); return false; }
        for (let i = 0; i < length; i += 65536) this.queue.push(bytes.subarray(i, Math.min(length, i + 65536)));
        this.pendingBytes += length;
        this.flushInput();
        return true;
    }
    private flushInput() {
        if (!this.canUpload() || this.socket?.readyState !== WebSocket.OPEN) return;
        let bytes = this.inFlight.reduce((sum, length) => sum + length, 0);
        // Match the server's bounded pipeline so typing never waits one round trip per key.
        while (this.queue.length && this.inFlight.length < 64 && bytes + this.queue[0].length <= 65536) {
            const frame = this.queue.shift()!;
            bytes += frame.length; this.inFlight.push(frame.length);
            try { this.socket.send(frame); }
            catch { this.socket.close(); return; }
        }
    }
    resize = () => { if (!this.host.checkVisibility()) this.closeText(); this.display?.resize(); clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.fitSize(), 80); };
    private fitSize() {
        if (this.disposed || !this.host.isConnected || this.host.clientWidth < 30 || this.host.clientHeight < 30)
            return;
        this.term.refresh(0, this.term.rows - 1);
        if (this.root.closest('.resizing-panel, .resizing-dividers')) return;
        if (!this.canUpload() || this.resizing)
            return;
        const proposed = terminalDimensions(this.term);
        if (proposed) {
            const columns = Math.max(2, Math.min(500, proposed.cols)), rows = Math.max(1, Math.min(200, proposed.rows));
            const size = `${columns}x${rows}`;
            if (this.lastSize !== size && (this.term.cols !== columns || this.term.rows !== rows)) {
                this.lastSize = size; this.resizing = true;
                this.sendControl({ type: 'resize', columns, rows });
            }
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
    dispose() { this.disposed = true; this.closeText(); this.events.abort(); this.control.remove(); clearTimeout(this.reconnect); clearTimeout(this.resizeTimer); clearTimeout(this.renderingTimer); this.socket?.close(); this.observer.disconnect(); this.display.dispose(); this.term.dispose(); }
}
