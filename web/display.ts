import { t, errorText } from './i18n';
import RFB from './vendor/novnc/core/rfb';
import { api, bindContextMenu, button, el, icon, notificationHost, notify, popover, scopeNotifications } from './ui';
import { overflowTabs } from './overflow';
import { displayClipboard } from './display-clipboard';
import { type DraggedFile } from './file-drag';
import { uploadBatch } from './transfers';
import { join, type User } from './model';

type Window = { id: number; title: string; icon?: string; active: boolean };
export type DisplayState = { ready: boolean; error?: string; windows: Window[] | null };

export class TerminalDisplay {
    private controls = el('div', 'display-controls');
    private terminalButton = button(t("common.terminal"), undefined, () => this.show(false, true), 'display-tab terminal-tab');
    private separator = el('span', 'display-separator', '|');
    private windows = el('div', 'display-windows');
    private frame = el('div', 'terminal-display');
    private screen = el('div', 'display-screen');
    private status = el('div', 'display-status');
    private buttons = new Map<number, { tab: HTMLButtonElement; group: HTMLElement; dispose: () => void }>();
    private closeMenu = () => {};
    private items: HTMLElement[] = [];
    private disposeOverflow: () => void;
    private state?: DisplayState;
    private rfb?: RFB;
    private request?: AbortController;
    private disposed = false;
    private clipboard?: ReturnType<typeof displayClipboard>;
    private events = new AbortController();
    private dropNotice?: HTMLElement;
    private resizeTimer?: ReturnType<typeof setTimeout>;
    private reconnect?: ReturnType<typeof setTimeout>;
    private connecting?: ReturnType<typeof setTimeout>;
    private attempt = 0;
    private focusOnConnect = false;
    private observer = new ResizeObserver(() => this.resize());
    visible = false;
    get connected() { return this.visible && !!this.clipboard && this.frame.getClientRects().length > 0 && this.frame.dataset.state === 'connected'; }

    constructor(private root: HTMLElement, private terminal: HTMLElement, private id: () => string | undefined, private focus: () => void, private user: User) {
        const header = root.closest('.panel')!.querySelector('.panel-header')!;
        this.terminalButton.replaceChildren(header.querySelector('svg')!, header.querySelector('.panel-title')!);
        this.controls.append(this.terminalButton, this.separator, this.windows);
        this.status.setAttribute('role', 'status');
        this.frame.append(this.screen, this.status); this.frame.hidden = true;
        root.append(this.frame);
        this.update();
        document.addEventListener('focusin', event => { this.focusOnConnect = this.root.contains(event.target as Node); }, { signal: this.events.signal });
        this.observer.observe(this.frame);
        this.disposeOverflow = overflowTabs(this.windows, this.items, t("display.moreWindows"), () => {});
    }

    rename(name: string) {
        this.terminalButton.title = name; this.terminalButton.setAttribute('aria-label', name);
        window.dispatchEvent(new Event('tuxee-tabs-changed'));
    }

    update(state?: DisplayState) {
        if (this.disposed) return;
        const previous = new Set(this.state?.windows?.map(w => w.id));
        this.state = state;
        const windows = state?.windows || [];
        const present = new Set(windows.map(w => w.id));
        for (const [id, item] of this.buttons) if (!present.has(id)) {
            this.closeMenu(); item.dispose(); item.group.remove(); this.buttons.delete(id);
            this.items.splice(this.items.indexOf(item.group), 1);
        }
        for (const window of windows) {
            let item = this.buttons.get(window.id);
            if (!item) {
                const b = button('', undefined, async () => {
                    await api(`/terminals/${this.id()}/display/window`, 'POST', { id: window.id });
                    this.show(true, true);
                }, 'display-tab display-window');
                b.dataset.window = String(window.id);
                const group = el('div', 'display-window-item');
                const menu = button(t("display.windowMenu"), 'ChevronDown', () => this.windowMenu(window.id, menu), 'display-window-menu');
                menu.setAttribute('aria-haspopup', 'menu');
                group.append(b, menu); scopeNotifications(group, this.root);
                item = { tab: b, group, dispose: bindContextMenu(group, position => this.windowMenu(window.id, b, position), true) };
                this.buttons.set(window.id, item); this.items.push(group);
            }
            const b = item.tab, title = window.title || t("display.windowNumber", { id: window.id });
            b.title = title; b.setAttribute('aria-label', title);
            if (b.dataset.icon !== (window.icon || '') || !b.firstChild) {
                b.dataset.icon = window.icon || '';
                if (window.icon) { const img = el('img'); img.src = window.icon; img.alt = ''; b.replaceChildren(img); }
                else b.replaceChildren(icon('Monitor'));
                b.append(el('span', 'display-title'));
            }
            b.querySelector('.display-title')!.textContent = title;
        }
        const opened = windows.some(w => !previous.has(w.id));
        this.show(!!state?.ready && windows.length > 0 && (this.visible || opened), opened);
        if (state?.error) notify(errorText(state), this.root);
    }

    private show(visible: boolean, focus = false) {
        const previous = this.visible, windows = this.state?.windows || [];
        this.visible = visible && !!this.state?.ready && windows.length > 0;
        this.terminal.hidden = this.visible; this.frame.hidden = !this.visible;
        this.separator.hidden = this.windows.hidden = windows.length === 0;
        this.terminalButton.classList.toggle('selected', !this.visible);
        this.terminalButton.classList.toggle('active', !this.visible && windows.length > 0);
        this.terminalButton.setAttribute('aria-pressed', String(!this.visible));
        for (const window of windows) {
            const selected = this.visible && window.active, item = this.buttons.get(window.id)!, b = item.tab;
            item.group.classList.toggle('active', selected);
            b.classList.toggle('active', selected); b.setAttribute('aria-pressed', String(selected));
        }
        if (this.visible && !this.rfb && !this.request && !this.reconnect) void this.connect();
        if (!this.visible) { this.disconnect(); this.attempt = 0; }
        this.resize();
        window.dispatchEvent(new Event('tuxee-tabs-changed'));
        if (focus || previous !== this.visible) {
            this.focusOnConnect = true;
            if (this.visible) this.rfb?.focus();
            else this.focus();
        }
    }

    private windowMenu(id: number, anchor: HTMLElement, position?: { x: number; y: number }) {
        this.closeMenu();
        const content = el('div', 'menu-actions'); scopeNotifications(content, this.root);
        const close = button(t("common.close"), 'X', () => {
            this.closeMenu();
            return api(`/terminals/${this.id()}/display/window`, 'DELETE', { id });
        });
        close.append(el('span', '', t("common.close"))); close.setAttribute('role', 'menuitem'); content.append(close);
        const rect = anchor.getBoundingClientRect();
        ({ close: this.closeMenu } = popover(position || { x: rect.left, y: rect.bottom }, content, anchor));
    }

    private async connect() {
        if (this.disposed || !this.visible || !this.state?.ready) return;
        this.disconnect();
        const request = this.request = new AbortController();
        this.frame.dataset.state = 'connecting';
        this.status.hidden = false; this.status.replaceChildren(el('span', '', t("term.loading")));
        this.connecting = setTimeout(() => this.disconnected(t("display.connectionFailed")), 15000);
        try {
            const session = await api<{ password: string }>(`/terminals/${this.id()}/display`, 'GET', undefined, request.signal);
            if (this.disposed || request.signal.aborted) return;
            const url = new URL(`/api/terminals/${this.id()}/display/ws`, location.href);
            url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const rfb = this.rfb = new RFB(this.screen, url.href, { credentials: session });
            rfb.scaleViewport = true; rfb.resizeSession = true; rfb.background = '#111827'; this.resize();
            rfb.addEventListener('connect', () => {
                if (this.rfb !== rfb) return;
                clearTimeout(this.connecting); this.connecting = undefined; this.attempt = 0;
                this.status.hidden = true; this.frame.dataset.state = 'connected';
                this.screen.querySelector('canvas')?.setAttribute('aria-label', t("display.terminalDisplay"));
                this.clipboard = displayClipboard(this.screen, rfb, this.root, {
                    path: `/terminals/${this.id()}/display`, uid: this.user.uid,
                    upload: files => uploadBatch(join(this.user.home, 'uploads'), files, this.root, this.events.signal, true)
                });
                if (this.visible && this.focusOnConnect) rfb.focus();
            });
            rfb.addEventListener('disconnect', () => {
                if (this.rfb !== rfb || this.disposed) return;
                this.disconnected(t("display.displayDisconnected"));
            });
        } catch (error) {
            if (!request.signal.aborted && !this.disposed) this.disconnected(error instanceof Error ? errorText(error) : t("display.connectionFailed"));
        } finally { if (this.request === request) this.request = undefined; }
    }

    private disconnected(message: string) {
        this.disconnect();
        if (this.disposed || !this.visible) return;
        this.frame.dataset.state = 'disconnected'; this.status.hidden = false;
        this.status.replaceChildren(el('span', '', message), button(t("display.reconnectDisplay"), undefined, () => this.connect(), 'primary'));
        this.reconnect = setTimeout(() => { this.reconnect = undefined; void this.connect(); }, Math.min(1000 * 2 ** this.attempt++, 15000));
    }

    resize() {
        const compact = !!this.root.closest('.compact-board');
        const parent = compact ? this.root : this.root.closest('.panel')!.querySelector('.panel-header')!;
        if (this.controls.parentElement !== parent) {
            if (compact) parent.prepend(this.controls);
            else parent.insertBefore(this.controls, parent.querySelector('.panel-tools'));
        }
        this.controls.hidden = compact && !this.state?.windows?.length;
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
            if (this.disposed || !this.frame.checkVisibility() || this.root.closest('.resizing-panel, .resizing-dividers')) return;
            // Keep noVNC's viewport fixed until the outer panel has settled.
            this.screen.style.width = `${this.frame.clientWidth}px`;
            this.screen.style.height = `${this.frame.clientHeight}px`;
        }, 80);
    }

    dropTarget(point?: { clientX: number; clientY: number }) {
        const canvas = this.screen.querySelector('canvas'), window = this.state?.windows?.find(window => window.active);
        if (!this.connected || !canvas || !window) throw new Error(t("display.guiDisplayIsUnavailable"));
        const rect = canvas.getBoundingClientRect();
        const x = point ? (point.clientX - rect.left) / rect.width : .5, y = point ? (point.clientY - rect.top) / rect.height : .5;
        this.rfb?.focus();
        return { window: window.id, x: Math.max(0, Math.min(canvas.width - 1, Math.floor(x * canvas.width))), y: Math.max(0, Math.min(canvas.height - 1, Math.floor(y * canvas.height))) };
    }

    async dropFiles(files: DraggedFile[], target: ReturnType<TerminalDisplay['dropTarget']>) {
        if (this.disposed || !this.connected || !this.state?.windows?.some(window => window.id === target.window && window.active)) {
            throw new Error(t("display.filesAreAvailableOnTheServerTheOriginalGUIWindow"));
        }
        this.dropNotice?.remove();
        try { await api(`/terminals/${this.id()}/display/drop`, 'POST', { ...target, files: files.map(file => file.path) }, this.events.signal); }
        catch (error) {
            if (this.disposed) return;
            notify(error, this.root);
            const paste = button(t("display.pastePaths"), 'ClipboardPaste', async () => {
                if (!this.visible || !this.state?.windows?.some(window => window.id === target.window && window.active)) throw new Error(t("display.selectTheOriginalGUIWindowFirst"));
                await this.clipboard?.pastePaths(files); this.dropNotice?.remove();
            });
            paste.append(el('span', '', t("display.pastePaths")));
            this.dropNotice = el('div', 'toast'); this.dropNotice.append(paste, button(t("display.clipboard.dismiss"), 'X', () => this.dropNotice?.remove()));
            notificationHost('notifications', this.root).append(this.dropNotice);
        }
    }

    private disconnect() {
        clearTimeout(this.reconnect); this.reconnect = undefined;
        clearTimeout(this.connecting); this.connecting = undefined;
        this.dropNotice?.remove();
        this.clipboard?.dispose(); this.clipboard = undefined;
        this.request?.abort(); this.request = undefined;
        const rfb = this.rfb; this.rfb = undefined; rfb?.disconnect();
        this.screen.replaceChildren(); delete this.frame.dataset.state;
    }

    dispose() { this.disposed = true; clearTimeout(this.resizeTimer); this.observer.disconnect(); this.events.abort(); this.closeMenu(); for (const item of this.buttons.values()) item.dispose(); this.disposeOverflow(); this.disconnect(); this.controls.remove(); this.frame.remove(); }
}
