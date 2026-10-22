import RFB from './vendor/novnc/core/rfb';
import { api, bindContextMenu, button, el, icon, notify, popover, scopeNotifications } from './ui';
import { overflowTabs } from './overflow';

type Window = { id: number; title: string; icon?: string; active: boolean };
export type DisplayState = { ready: boolean; error?: string; windows: Window[] | null };

export class TerminalDisplay {
    private controls = el('div', 'display-controls');
    private terminalButton = button('Terminal', undefined, () => this.show(false, true), 'display-tab terminal-tab');
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
    visible = false;

    constructor(private root: HTMLElement, private terminal: HTMLElement, private id: () => string | undefined, private focus: () => void) {
        const header = root.closest('.panel')!.querySelector('.panel-header')!;
        this.terminalButton.replaceChildren(header.querySelector('svg')!, header.querySelector('.panel-title')!);
        this.controls.append(this.terminalButton, this.separator, this.windows);
        this.status.setAttribute('role', 'status');
        this.frame.append(this.screen, this.status); this.frame.hidden = true;
        root.append(this.frame);
        this.update();
        this.disposeOverflow = overflowTabs(this.windows, this.items, 'More windows', () => {});
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
                const menu = button('Window menu', 'ChevronDown', () => this.windowMenu(window.id, menu), 'display-window-menu');
                menu.setAttribute('aria-haspopup', 'menu');
                group.append(b, menu); scopeNotifications(group, this.root);
                item = { tab: b, group, dispose: bindContextMenu(group, position => this.windowMenu(window.id, b, position), true) };
                this.buttons.set(window.id, item); this.items.push(group);
            }
            const b = item.tab, title = window.title || `Window ${window.id}`;
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
        if (state?.error) notify(state.error, this.root);
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
        if (this.visible && !this.rfb && !this.request) void this.connect();
        if (!this.visible) this.disconnect();
        this.resize();
        window.dispatchEvent(new Event('tuxee-tabs-changed'));
        if (focus || previous !== this.visible) {
            if (this.visible) this.rfb?.focus();
            else this.focus();
        }
    }

    private windowMenu(id: number, anchor: HTMLElement, position?: { x: number; y: number }) {
        this.closeMenu();
        const content = el('div', 'menu-actions'); scopeNotifications(content, this.root);
        const close = button('Close', 'X', () => {
            this.closeMenu();
            return api(`/terminals/${this.id()}/display/window`, 'DELETE', { id });
        });
        close.append(el('span', '', 'Close')); close.setAttribute('role', 'menuitem'); content.append(close);
        // Opening a context menu dismisses overflow, so return focus to its visible control.
        const returnFocus = anchor.closest('.overflow-tabs') ? this.windows.querySelector<HTMLElement>('.overflow-toggle')! : anchor;
        const rect = anchor.getBoundingClientRect();
        ({ close: this.closeMenu } = popover(position || { x: rect.left, y: rect.bottom }, content, returnFocus));
    }

    private async connect() {
        this.disconnect();
        const request = this.request = new AbortController();
        this.status.hidden = false; this.status.replaceChildren(el('span', '', 'Connecting…'));
        try {
            const session = await api<{ password: string }>(`/terminals/${this.id()}/display`, 'GET', undefined, request.signal);
            if (this.disposed || request.signal.aborted) return;
            const url = new URL(`/api/terminals/${this.id()}/display/ws`, location.href);
            url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const rfb = this.rfb = new RFB(this.screen, url.href, { credentials: session });
            rfb.scaleViewport = true; rfb.resizeSession = true; rfb.background = '#111827'; this.resize();
            rfb.addEventListener('connect', () => {
                if (this.rfb !== rfb) return;
                this.status.hidden = true; this.frame.dataset.state = 'connected';
                this.screen.querySelector('canvas')?.setAttribute('aria-label', 'Terminal display');
                if (this.visible) rfb.focus();
            });
            rfb.addEventListener('disconnect', () => {
                if (this.rfb !== rfb || this.disposed) return;
                this.disconnected('Display disconnected');
            });
        } catch (error) {
            if (!request.signal.aborted && !this.disposed) this.disconnected(error instanceof Error ? error.message : 'Connection failed');
        } finally { if (this.request === request) this.request = undefined; }
    }

    private disconnected(message: string) {
        this.frame.dataset.state = 'disconnected'; this.status.hidden = false;
        this.status.replaceChildren(el('span', '', message), button('Reconnect display', undefined, () => this.connect(), 'primary'));
    }

    resize() {
        const compact = !!this.root.closest('.compact-board');
        const parent = compact ? this.root : this.root.closest('.panel')!.querySelector('.panel-header')!;
        if (this.controls.parentElement !== parent) {
            if (compact) parent.prepend(this.controls);
            else parent.insertBefore(this.controls, parent.querySelector('.panel-tools'));
        }
        this.controls.hidden = compact && !this.state?.windows?.length;
    }

    private disconnect() {
        this.request?.abort(); this.request = undefined;
        const rfb = this.rfb; this.rfb = undefined; rfb?.disconnect();
        this.screen.replaceChildren(); delete this.frame.dataset.state;
    }

    dispose() { this.disposed = true; this.closeMenu(); for (const item of this.buttons.values()) item.dispose(); this.disposeOverflow(); this.disconnect(); this.controls.remove(); this.frame.remove(); }
}
