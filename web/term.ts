import { t, errorText } from './i18n';
import { TerminalDisplay } from './display';
import { Terminal } from '@xterm/xterm';
import { installTerminalView, installTerminalMetrics, installTerminalUnicode, installTerminalResize, terminalDimensions, restoreTerminal, terminalTheme, setTerminalBackground, retainedScrollback, MAX_SNAPSHOT_BYTES } from './terminal/state';
import { installTerminalTouch } from './terminal/interaction';
import { api, APIError, button, el, notify, ask, popover, confirmAction } from './ui';
import { registerFileDrop, registerUploadInput, setDropFeedback, shellPaths, animateFileDrop, type DraggedFile } from './file-drag';
import { readFileClipboard } from './file-clipboard';
import { uploadBatch, type UploadSource } from './transfers';
import { join, type Panel, type Hooks, type View, type TerminalInfo } from './model';
const creating = new Map<string, Promise<TerminalInfo>>();
export const TERMINAL_FONT = { size: 13, family: 'ui-monospace, SFMono-Regular, Consolas, monospace', maxFamilyLength: 512 } as const;
function terminalFontFamily(value: string) {
    const style = document.createElement('span').style;
    style.fontFamily = value;
    // Serialize before xterm interpolates CSS, including quotes closed by the parser.
    return style.fontFamily || TERMINAL_FONT.family;
}
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
    private resetting = false;
    private resetButton = button(t("term.resetTerminal"), 'Power', () => this.reset());
    private events = new AbortController();
    private control = button(t("app.takeControl"), 'Hand', () => this.sendControl({ type: 'take-control' }));
    private name = t("common.terminal");
    private surface = el('div', 'terminal-surface');
    private host = el('div', 'terminal-host');
    private drawer = el('textarea', 'terminal-input');
    private cancelDrawerResize?: () => void;
    private closeText = () => {};
    private rendering = el('div', 'terminal-rendering', t("term.loading"));
    private renderingStarted = performance.now();
    private renderingTimer?: ReturnType<typeof setTimeout>;
    constructor(private root: HTMLElement, private panel: Panel, private hooks: Hooks, fontSize: number = TERMINAL_FONT.size, fontFamily: string = TERMINAL_FONT.family) {
        fontFamily = terminalFontFamily(fontFamily);
        root.classList.add('terminal-view');
        Terminal.strings.promptLabel = t('terminal.inputLabel');
        Terminal.strings.tooMuchOutput = t('terminal.tooMuchOutput');
        this.term = new Terminal({ allowProposedApi: true, fontFamily, fontSize, lineHeight: 1, cursorBlink: true, disableStdin: true, scrollback: retainedScrollback(80, 24),
            theme: { ...terminalTheme, selectionBackground: '#58a6ff9e', selectionInactiveBackground: '#58a6ff6b' },
            linkHandler: { activate: (_event, uri) => { window.open(uri, '_blank', 'noopener,noreferrer'); } } });
        installTerminalUnicode(this.term);
        this.control.dataset.action = 'take-control';
        this.control.append(el('span', '', t("term.control")));
        this.control.hidden = true;
        const controls = root.closest('.panel')!.querySelector('.panel-tools')!;
        controls.prepend(this.control);
        root.append(this.surface);
        this.surface.append(this.host);
        const dropTarget = root.closest<HTMLElement>('.panel')!;
        registerFileDrop(dropTarget, {
            over: () => { const accepted = this.canDrop(); setDropFeedback(root, accepted ? this.display?.visible ? t("term.dropFiles") : t("common.paste") : undefined); return accepted; },
            leave: () => setDropFeedback(root),
            drop: drop => {
                if (this.display.visible) {
                    try { void this.display.dropFiles(drop.files, this.display.dropTarget(drop)).catch(this.notice); } catch (error) { this.notice(error); }
                } else {
                    this.pasteFiles(drop.files, drop);
                    if (this.drawer.hidden) this.term.focus(); else this.drawer.focus();
                }
            }
        }, this.events.signal);
        const paste = registerUploadInput(dropTarget, {
            accept: () => this.canDrop(),
            over: () => setDropFeedback(root, this.display?.visible ? t("term.uploadAndDrop") : t("term.uploadAndPaste")),
            leave: () => setDropFeedback(root),
            upload: (sources, point) => { void this.uploadFiles(sources, point); },
            paste: data => {
                if (this.drawer.hidden || this.display.visible) return false;
                try {
                    const clipboard = readFileClipboard(data, this.hooks.user.uid);
                    if (!clipboard) return false;
                    this.pasteFiles(clipboard.paths.map(path => ({ path, name: path.split('/').pop()! })));
                    this.drawer.focus();
                } catch (error) { this.notice(error); }
                return true;
            }
        }, this.events.signal);
        this.drawer.addEventListener('paste', event => {
            if (!event.clipboardData || !paste(event.clipboardData)) return;
            event.preventDefault(); event.stopImmediatePropagation();
        }, { signal: this.events.signal });
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
        const top = button(t("term.jumpToTop"), 'ArrowUp', () => scroll(true));
        const bottom = button(t("term.jumpToBottom"), 'ArrowDown', () => scroll(false));
        const updateScroll = () => {
            const buffer = this.term.buffer.active;
            top.disabled = buffer.type !== 'normal' || buffer.viewportY === 0;
            bottom.disabled = buffer.type !== 'normal' || buffer.viewportY === buffer.baseY;
        };
        const drawer = this.drawer;
        const history: { text: string; draft: string }[] = [];
        let historyIndex = 0, liveDraft = '';
        const browseHistory = (step: number) => {
            if (historyIndex < history.length) history[historyIndex].draft = drawer.value;
            else liveDraft = drawer.value;
            historyIndex = Math.max(0, Math.min(history.length, historyIndex + step));
            drawer.value = history[historyIndex]?.draft ?? liveDraft;
            updateHistory();
            drawer.focus(); drawer.setSelectionRange(drawer.value.length, drawer.value.length);
        };
        const previousInput = button(t("term.previousInput"), 'ArrowUp', () => browseHistory(-1));
        const nextInput = button(t("term.nextInput"), 'ArrowDown', () => browseHistory(1));
        const historySeparator = el('span', 'terminal-footer-separator', '|');
        historySeparator.setAttribute('aria-hidden', 'true');
        const updateHistory = () => {
            previousInput.hidden = nextInput.hidden = historySeparator.hidden = drawer.hidden;
            previousInput.disabled = historyIndex === 0;
            nextInput.disabled = historyIndex === history.length;
        };
        drawer.rows = 3; drawer.hidden = true; drawer.spellcheck = false;
        updateHistory();
        drawer.setAttribute('autocapitalize', 'off'); drawer.setAttribute('autocorrect', 'off');
        drawer.setAttribute('aria-label', t("term.terminalInputDrawer"));
        drawer.placeholder = t("term.enterSendCtrlEnterInsertShiftEnterNewLine");
        const drawerGrip = el('div', 'terminal-input-resize');
        drawerGrip.hidden = true; drawerGrip.tabIndex = 0;
        drawerGrip.setAttribute('role', 'separator');
        drawerGrip.setAttribute('aria-label', t("term.resizeTerminalInput"));
        drawerGrip.setAttribute('aria-orientation', 'horizontal');
        const updateDrawerGrip = () => {
            if (drawer.hidden) return;
            const minimum = parseFloat(getComputedStyle(drawer).lineHeight) + 18;
            drawerGrip.setAttribute('aria-valuemin', String(Math.round(minimum)));
            drawerGrip.setAttribute('aria-valuemax', String(Math.round(Math.max(minimum, this.surface.clientHeight - 72))));
            drawerGrip.setAttribute('aria-valuenow', String(drawer.offsetHeight));
            drawerGrip.setAttribute('aria-valuetext', t("terminal.drawerHeight", { height: drawer.offsetHeight }));
        };
        const setDrawerHeight = (height: number) => {
            drawer.style.height = `${Math.max(0, height)}px`;
            updateDrawerGrip();
        };
        drawerGrip.onpointerdown = event => {
            if (event.button !== 0 || !event.isPrimary || this.cancelDrawerResize) return;
            event.preventDefault(); event.stopPropagation();
            this.resizeDisplay.release(); this.closeText();
            const original = drawer.style.height, height = drawer.offsetHeight, start = event.clientY;
            const events = new AbortController(), signal = events.signal;
            drawerGrip.setPointerCapture(event.pointerId);
            drawerGrip.classList.add('dragging');
            const finish = (cancelled: boolean) => {
                events.abort(); this.cancelDrawerResize = undefined;
                if (drawerGrip.hasPointerCapture(event.pointerId)) drawerGrip.releasePointerCapture(event.pointerId);
                drawerGrip.classList.remove('dragging');
                drawer.style.height = cancelled ? original : `${drawer.offsetHeight}px`;
                updateDrawerGrip(); this.resize();
            };
            this.cancelDrawerResize = () => finish(true);
            drawerGrip.addEventListener('pointermove', move => {
                if (move.pointerId === event.pointerId) setDrawerHeight(height + start - move.clientY);
            }, { signal });
            drawerGrip.addEventListener('pointerup', up => { if (up.pointerId === event.pointerId) finish(false); }, { signal });
            drawerGrip.addEventListener('pointercancel', () => finish(true), { signal });
            drawerGrip.addEventListener('lostpointercapture', () => finish(true), { signal });
            window.addEventListener('blur', () => finish(true), { signal });
            window.addEventListener('resize', () => finish(true), { signal });
            window.addEventListener('keydown', key => {
                if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(true); }
            }, { capture: true, signal });
        };
        drawerGrip.onkeydown = event => {
            if (this.cancelDrawerResize || !["ArrowUp", 'ArrowDown', "Home", "End"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            const step = parseFloat(getComputedStyle(drawer).lineHeight);
            setDrawerHeight(event.key === 'Home' ? 0 : event.key === 'End' ? this.surface.clientHeight - 72 : drawer.offsetHeight + (event.key === 'ArrowUp' ? step : -step));
        };
        const toggle = button(t("term.toggleTerminalInput"), 'TextCursorInput', () => {
            this.cancelDrawerResize?.();
            drawerGrip.hidden = drawer.hidden = !drawer.hidden;
            toggle.setAttribute('aria-expanded', String(!drawer.hidden));
            updateDrawerGrip(); updateHistory();
            if (drawer.hidden) this.term.focus(); else drawer.focus();
        });
        toggle.setAttribute('aria-expanded', 'false');
        drawer.onkeydown = event => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
            event.preventDefault(); event.stopPropagation();
            if (!this.canUpload()) { this.notice(t("term.terminalIsNotReadyForInput")); return; }
            // Queue paste and Enter atomically so a rejected paste can never execute a partial command.
            let data = drawer.value.replace(/\r?\n/g, '\r');
            if (this.term.modes.bracketedPasteMode && data) data = '\x1b[200~' + data + '\x1b[201~';
            if (!event.ctrlKey) data += '\r';
            if (this.input(data)) {
                const text = drawer.value;
                if (historyIndex < history.length) history[historyIndex].draft = history[historyIndex].text;
                else liveDraft = '';
                if (text && text !== history.at(-1)?.text) {
                    history.push({ text, draft: text });
                    if (history.length > 50) history.shift();
                }
                historyIndex = history.length; drawer.value = liveDraft;
                updateHistory(); this.term.scrollToBottom();
            }
        };
        const text = button(t("term.terminalContentsAsText"), undefined, () => this.showText(text));
        text.textContent = t("term.t"); text.setAttribute('aria-haspopup', 'dialog'); text.setAttribute('aria-expanded', 'false');
        const footer = el('div', 'terminal-footer'), left = el('div'), right = el('div');
        left.append(toggle, previousInput, nextInput, historySeparator, text);
        const separator = el('span', 'terminal-footer-separator', '|');
        separator.setAttribute('aria-hidden', 'true');
        right.append(button(t("term.renameTerminal"), 'Pencil', () => this.renamePanel()), button(t("term.reconnectTerminal"), 'RefreshCw', () => { if (!this.resetting) this.connect(); }), this.resetButton, separator, top, bottom);
        footer.append(left, right); this.surface.append(drawerGrip, drawer, footer);
        updateScroll();
        this.rendering.setAttribute('role', 'status');
        this.host.append(this.rendering);
        this.term.onScroll(updateScroll);
        this.term.onRender(() => {
            this.rendering.style.backgroundColor = this.term.element!.style.backgroundColor;
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
            if (event.code === 'KeyC' && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && !event.isComposing) {
                event.preventDefault(); event.stopPropagation();
                if (event.type === 'keydown' && !event.repeat && this.term.hasSelection()) document.execCommand('copy');
                return false;
            }
            if (event.key !== 'Enter' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return true;
            // shortcut: CSI-u for Shift+Enter only; broader keyboard modes need shared engine support.
            event.preventDefault(); event.stopPropagation();
            if (event.type === 'keydown') this.term.input('\x1b[13;2u');
            return false;
        });
        this.observer = new ResizeObserver(() => { updateDrawerGrip(); this.closeText(); this.resize(); });
        this.observer.observe(this.host);
        this.starting = this.start().catch(error => { this.state('unavailable'); this.notice(error); });
    }
    private showText(anchor: HTMLElement) {
        if (anchor.getAttribute('aria-expanded') === 'true') { this.closeText(); return; }
        this.closeText();
        const content = el('div', 'terminal-text'), text = el('pre');
        content.setAttribute('role', 'dialog'); content.setAttribute('aria-label', t("term.terminalContents"));
        const rect = this.host.getBoundingClientRect();
        content.style.width = `${rect.width}px`; content.style.height = `${rect.height}px`;
        const style = getComputedStyle(this.term.element!);
        const row = this.term.element!.querySelector('.xterm-rows > div')!;
        const rows = getComputedStyle(row), rowHeight = row.getBoundingClientRect().height;
        Object.assign(text.style, { fontFamily: rows.fontFamily, fontSize: rows.fontSize, lineHeight: `${rowHeight}px`, letterSpacing: rows.letterSpacing, fontVariantLigatures: rows.fontVariantLigatures });
        text.style.padding = style.padding;
        text.tabIndex = 0;
        text.setAttribute('role', 'textbox'); text.setAttribute('aria-readonly', 'true'); text.setAttribute('aria-multiline', 'true');
        text.setAttribute('aria-label', t("term.terminalContentsAsText"));
        text.onkeydown = event => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
                event.preventDefault(); event.stopPropagation();
                const range = document.createRange(); range.selectNodeContents(text);
                const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
            }
        };
        const buffer = this.term.buffer.active, lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i)!;
            lines.push(line.translateToString(false));
        }
        text.textContent = lines.join('\n');
        content.append(text);
        ({ close: this.closeText } = popover(anchor, content));
        content.style.left = `${rect.left}px`; content.style.top = `${rect.top}px`;
        text.focus({ preventScroll: true });
        // Keep the spare pixels below the last terminal row so bottom scrolling stays aligned.
        text.style.paddingBottom = `${Math.max(parseFloat(style.paddingBottom), text.clientHeight - parseFloat(style.paddingTop) - this.term.rows * rowHeight)}px`;
        text.scrollTop = buffer.viewportY * rowHeight;
    }
    private notice = (value: unknown) => notify(value, this.root);
    private canUpload() { return this.ready && this.controller && !this.ended && !this.disposed && !this.closing; }
    private canDrop() { return this.display?.visible ? this.display.connected && !this.disposed && !this.closing : this.canUpload(); }
    private pasteFiles(files: DraggedFile[], point?: { clientX: number; clientY: number }, toDrawer = !this.drawer.hidden) {
        const target = toDrawer || !this.drawer.hidden ? this.drawer : this.host;
        const text = shellPaths(files);
        if (target === this.drawer) this.drawer.setRangeText(text, this.drawer.selectionStart, this.drawer.selectionEnd, 'end');
        else this.term.paste(text);
        if (point && target.checkVisibility()) animateFileDrop(files, point, target);
    }
    private async uploadFiles(sources: UploadSource[], point?: { clientX: number; clientY: number }) {
        const toDrawer = !this.drawer.hidden;
        let target: ReturnType<TerminalDisplay['dropTarget']> | undefined;
        if (this.display.visible) {
            try { target = this.display.dropTarget(point); } catch (error) { this.notice(error); return; }
        } else if (toDrawer) this.drawer.focus(); else this.term.focus();
        let uploaded;
        try { uploaded = await uploadBatch(join(this.hooks.user.home, 'uploads'), sources, this.root, this.events.signal, true); }
        catch { return; } // The batch indicator owns upload errors and cancellation.
        if (!uploaded.length) return;
        if (target) { try { await this.display.dropFiles(uploaded, target); } catch (error) { this.notice(error); } return; }
        if (!this.canUpload()) {
            if (!this.disposed) this.notice(t("term.uploadedToUploadsTerminalNoLongerAcceptsInput"));
            return;
        }
        if (this.display.visible) { this.notice(t("term.uploadedToUploadsTerminalIsNoLongerVisible")); return; }
        this.pasteFiles(uploaded, point, toDrawer);
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
    private sessionLost(lost: string | undefined) {
        if (this.disposed || this.closing) return;
        this.ended = true; this.ready = false; this.control.hidden = true;
        this.state('ended');
        this.display.update();
        clearTimeout(this.reconnect);
        const socket = this.socket; this.socket = undefined; socket?.close();
        this.root.querySelector('.terminal-recovery')?.remove();
        this.surface.hidden = true;
        this.root.classList.add('session-lost');
        const recovery = el('div', 'terminal-recovery'), message = el('p', '', t("term.terminalSessionLost"));
        message.setAttribute('role', 'status');
        const restart = button(t("term.restartTerminal"), undefined, () => {
            restart.disabled = true;
            if (this.panel.terminal === lost) delete this.panel.terminal;
            if (!this.panel.terminal) this.panel.path = this.hooks.defaultDirectory();
            this.ended = false;
            this.starting = (async () => {
                // Retry a failed save without abandoning the replacement shell.
                if (this.panel.terminal) await this.hooks.changed(true);
                await this.start();
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
                this.sessionLost(this.panel.terminal);
                return;
            }
        }
        else {
            let pending = creating.get(this.panel.id);
            if (!pending) {
                pending = api<TerminalInfo>('/terminals', 'POST', { directory: this.panel.path, name: this.name, columns: 80, rows: 24 }).then(async (value) => { this.panel.terminal = value.id; await this.hooks.changed(true); return value; }).finally(() => creating.delete(this.panel.id));
                creating.set(this.panel.id, pending);
            }
            info = await pending;
        }
        this.name = info.name;
        this.hooks.title?.(info.name); this.display.rename(info.name);
        this.root.dataset.terminal = info.id;
        if (!this.disposed && !this.closing) {
            this.root.querySelector('.terminal-recovery')?.remove(); this.root.classList.remove('session-lost');
            this.surface.hidden = false;
            this.connect();
        }
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
        const terminal = this.panel.terminal;
        const ws = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminals/${terminal}/ws`);
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
                    if (bytes < 9 || bytes > 32776) throw Error(t("term.invalidTerminalOutputFrame"));
                    value = { type: 'data', sequence: Number(new DataView(event.data).getBigUint64(0)), data: new Uint8Array(event.data, 8) };
                } else {
                    bytes = event.data.length;
                    if (bytes > (received ? 1 << 20 : MAX_SNAPSHOT_BYTES + (1 << 20))) throw Error(t("term.terminalMessageIsTooLarge"));
                    value = JSON.parse(event.data);
                    if (!value || typeof value !== 'object') throw Error(t("term.invalidTerminalMessage"));
                    if (value.type !== 'snapshot' && bytes > 1 << 20) throw Error(t("term.terminalMessageIsTooLarge"));
                }
                const unsequenced = value.type === 'ack' || value.type === 'resize-ack' || (value.type === 'error' && value.sequence === undefined);
                if (!unsequenced) {
                    if (!Number.isSafeInteger(value.sequence) || value.sequence !== received + 1 || (!received && value.type !== 'snapshot'))
                        throw Error(t("term.terminalOutputIsOutOfOrder"));
                    received = value.sequence;
                }
                switch (value.type) {
                    case 'ack':
                        if (!this.inFlight.length || value.sequence !== undefined) throw Error(t("term.unexpectedTerminalInputAcknowledgement"));
                        this.pendingBytes -= this.inFlight.shift()!; this.flushInput(); return;
                    case 'resize-ack':
                        if (!this.resizing || value.sequence !== undefined) throw Error(t("term.unexpectedTerminalResizeAcknowledgement"));
                        this.resizing = false; this.resize(); return;
                    case 'error':
                        this.resizeDisplay.release();
                        if (typeof value.message !== 'string') throw Error(t("term.invalidTerminalError"));
                        this.discardInput(); this.notice(errorText(value));
                        if (value.sequence === undefined) return;
                        break;
                    case 'snapshot':
                        if (received !== 1 || typeof value.control !== 'boolean') throw Error(t("term.unexpectedTerminalSnapshot"));
                        break;
                    case 'control':
                        if (typeof value.control !== 'boolean') throw Error(t("term.invalidTerminalControlState"));
                        this.controller = value.control;
                        if (!this.controller) {
                            if (this.pendingBytes) this.notice(t("term.controlMovedCheckYourLastInputBeforeContinuing"));
                            this.uncertainInput ||= this.pendingBytes > 0;
                            this.queue = []; this.pendingBytes = this.inFlight.reduce((sum, bytes) => sum + bytes, 0);
                        } else { this.lastSize = ''; this.resize(); }
                        break;
                    case 'resize':
                        if (!Number.isInteger(value.columns) || value.columns < 2 || value.columns > 500 ||
                            !Number.isInteger(value.rows) || value.rows < 1 || value.rows > 200) throw Error(t("term.invalidTerminalSize"));
                        break;
                    case 'exit': this.ended = true; this.display.update(); break;
                    case 'closed': this.sessionLost(terminal); return;
                    case 'display': break;
                    case 'background':
                        for (const color of [value.background, value.foreground]) if (color !== undefined && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) throw Error(t("term.invalidTerminalColor"));
                        break;
                    case 'data':
                        if (!(value.data instanceof Uint8Array)) throw Error(t("term.invalidTerminalOutputFrame"));
                        break;
                    default: throw Error(t("term.unknownTerminalMessage"));
                }
                if (value.type === 'snapshot') bytes = 0; // Recovery has its own size/admission limit.
                queuedBytes += bytes;
                if (++queuedFrames > 512 || queuedBytes > 1 << 20) throw Error(t("term.terminalRendererIsFallingBehind"));
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
                                this.notice(t("term.connectionRestored"));
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
                        case 'background': setTerminalBackground(this.term, value.background || '', value.foreground); break;
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
                    await api(`/terminals/${terminal}`);
                    if (this.socket || this.ended || this.resetting || this.panel.terminal !== terminal) return;
                    this.connect();
                }
                catch (error) {
                    if (this.disposed || this.closing || this.socket || this.ended || this.resetting || this.panel.terminal !== terminal)
                        return;
                    if (error instanceof APIError && error.status === 404) {
                        this.sessionLost(terminal);
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
        const busy = () => this.notice(t("term.inputIsBusyWaitBeforePastingMore"));
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
    setFont(size: number = TERMINAL_FONT.size, family: string = TERMINAL_FONT.family) {
        family = terminalFontFamily(family);
        if (this.term.options.fontSize === size && this.term.options.fontFamily === family) return;
        this.closeText(); this.resizeDisplay.release();
        this.term.options = { fontSize: size, fontFamily: family };
        this.resize();
    }
    resize = () => { if (!this.host.checkVisibility()) { this.cancelDrawerResize?.(); this.closeText(); } this.display?.resize(); clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.fitSize(), 80); };
    private fitSize() {
        if (this.disposed || this.cancelDrawerResize || !this.host.isConnected || this.host.clientWidth < 30 || this.host.clientHeight < 30)
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
        const name = await ask(t("term.renameTerminal"), t("common.name"), this.name, 'Terminal');
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
    private reset() {
        if (this.disposed || this.closing || this.resetting) return;
        this.resetting = this.resetButton.disabled = true;
        this.starting = this.starting.then(async () => {
            if (this.disposed || this.closing) return;
            if (!await confirmAction(t("term.resetConfirmationTitle"), t("term.resetConsequences"), t("term.killAndReset"))) return;
            if (this.disposed || this.closing) return;
            const lost = this.panel.terminal;
            clearTimeout(this.reconnect);
            const previous = this.socket; this.socket = undefined; previous?.close();
            this.ready = this.controller = false;
            this.discardInput(); this.closeText(); this.state('connecting');
            try { await terminateTerminal(this.panel); }
            catch (error) { this.connect(); throw error; }
            delete this.panel.terminal;
            this.panel.path = this.hooks.defaultDirectory();
            this.ended = this.uncertainInput = false;
            this.display.update();
            if (this.disposed || this.closing) { await this.hooks.changed(true); return; }
            try { await this.start(); }
            catch (error) { this.sessionLost(lost); throw error; }
        }).catch(error => { if (!this.disposed && !this.closing) this.notice(error); })
            .finally(() => { this.resetting = this.resetButton.disabled = false; });
        return this.starting;
    }
    dispose() { this.disposed = true; this.cancelDrawerResize?.(); this.closeText(); this.events.abort(); this.control.remove(); clearTimeout(this.reconnect); clearTimeout(this.resizeTimer); clearTimeout(this.renderingTimer); this.socket?.close(); this.observer.disconnect(); this.display.dispose(); this.term.dispose(); }
}
