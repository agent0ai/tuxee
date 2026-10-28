import { t, errorText } from './i18n';
import { createElement, Volume1, Volume2, VolumeX, Monitor, X, ChevronDown, ChevronLeft, ChevronRight, TriangleAlert, Activity, Search, FilePlus, FolderPlus, TextCursorInput, SquareTerminal, Hand, Pencil, Pin, Copy, Scissors, ClipboardPaste, ArrowUp, ArrowDown, Undo2, Redo2, ZoomIn, ZoomOut, Scan, House, RefreshCw, Power, Upload, Download, MoveRight, Ellipsis, Info, Folder, Link, File, Trash2, Plus, Sun, Moon, Menu, UserRound, Settings, LogOut, LayoutPanelTop, ArrowLeft, ArrowRight, Save, FilePenLine, Archive, FolderOpen } from 'lucide';
const icons = { Volume1, Volume2, VolumeX, Monitor, X, ChevronDown, ChevronLeft, ChevronRight, TriangleAlert, Activity, Search, FilePlus, FolderPlus, TextCursorInput, SquareTerminal, Hand, Pencil, Pin, Copy, Scissors, ClipboardPaste, ArrowUp, ArrowDown, Undo2, Redo2, ZoomIn, ZoomOut, Scan, House, RefreshCw, Power, Upload, Download, MoveRight, Ellipsis, Info, Folder, Link, File, Trash2, Plus, Sun, Moon, Menu, UserRound, Settings, LogOut, LayoutPanelTop, ArrowLeft, ArrowRight, Save, FilePenLine, Archive, FolderOpen };
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = cls;
    if (text)
        node.textContent = text;
    if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement) {
        if (!(node instanceof HTMLSelectElement)) node.dir = 'auto';
        node.addEventListener('input', () => node.setCustomValidity(''));
        node.addEventListener('invalid', () => {
            node.setCustomValidity('');
            node.setCustomValidity(t(node.validity.valueMissing ? 'validation.required' : 'validation.invalid'));
        });
    }
    return node;
}
export function icon(name: keyof typeof icons): SVGElement {
    const value = createElement(icons[name]); value.setAttribute('aria-hidden', 'true');
    if (['ArrowLeft', 'ArrowRight', 'ChevronLeft', 'ChevronRight', 'MoveRight', 'Undo2', 'Redo2'].includes(name)) value.classList.add('directional-icon');
    return value;
}
export function button(label: string, name?: keyof typeof icons, action?: () => unknown, cls = ''): HTMLButtonElement {
    const b = el('button', cls);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (name)
        b.append(icon(name));
    else
        b.textContent = label;
    if (action)
        b.onclick = () => {
            const owner = notificationOwner(b);
            try { Promise.resolve(action()).catch(error => notify(error, owner)); }
            catch (error) { notify(error, owner); }
        };
    return b;
}
let csrf = '';
export class APIError extends Error {
    constructor(message: string, readonly status: number, readonly command?: string) { super(message); }
}
export function setCSRF(value: string) { csrf = value; }
export function requestHeaders() { return { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' }; }
export async function api<T = any>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const token = csrf;
    try {
        const response = await fetch(`/api${path}`, { method, cache: 'no-store', headers: { ...requestHeaders(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
        if (response.status >= 500) window.dispatchEvent(new Event('tuxee-connection-check'));
        if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error(t("ui.unexpectedAPIResponse"));
        const data = await response.json();
        if (!response.ok) {
            if (typeof data?.error !== 'string') throw new Error(t("ui.unexpectedAPIResponse"));
            if ((response.status === 401 || response.status === 403) && token && token === csrf)
                window.dispatchEvent(new Event('tuxee-unauthorized'));
            throw new APIError(errorText(data), response.status, typeof data.command === 'string' ? data.command : undefined);
        }
        return data;
    } catch (error) {
        if (!signal?.aborted && !(error instanceof APIError)) {
            window.dispatchEvent(new Event('tuxee-connection-lost'));
            throw new Error(t("ui.connectionLostTryAgainWhenReconnected"));
        }
        throw error;
    }
}
const notificationOwners = new WeakMap<HTMLElement, HTMLElement>();
export function scopeNotifications(content: HTMLElement, owner: HTMLElement) { notificationOwners.set(content, owner); }
function notificationOwner(node?: HTMLElement): HTMLElement | undefined {
    for (let current = node; current; current = current.parentElement || undefined) {
        const owner = notificationOwners.get(current);
        if (owner) return owner;
        if (current.classList.contains('panel')) return current;
    }
}
export function notificationHost(kind: 'notifications' | 'transfers', owner?: HTMLElement): HTMLElement {
    const panel = notificationOwner(owner);
    if (!panel?.isConnected) return document.querySelector(`#${kind}`)!;
    let host = panel.querySelector<HTMLElement>(`.component-${kind}`);
    if (!host) { host = el('div', `component-${kind}`); panel.append(host); }
    return host;
}
export function notify(value: unknown, owner?: HTMLElement) {
    const message = el('div', 'toast', value instanceof Error ? errorText(value) : String(value));
    message.setAttribute('role', 'status');
    message.append(button(t("display.clipboard.dismiss"), 'X', () => message.remove()));
    notificationHost('notifications', owner).append(message);
    setTimeout(() => message.remove(), 8000);
}
export function modal(title: string, content: HTMLElement): {
    dialog: HTMLDialogElement;
    close: () => void;
} {
    const dialog = el('dialog', 'modal');
    dialog.setAttribute('aria-label', title);
    const head = el('header', 'modal-head');
    head.append(el('h2', '', title), button(t("ui.closeDialog"), 'X', () => dialog.close()));
    const body = el('div', 'modal-body');
    body.append(content);
    dialog.append(head, body);
    document.body.append(dialog);
    dialog.onclose = () => dialog.remove();
    dialog.showModal();
    return { dialog, close: () => dialog.close() };
}
const popovers: { content: HTMLElement; close: () => void }[] = [];
export function bindContextMenu(target: HTMLElement, open: (position?: { x: number; y: number }) => void, longPress = false) {
    const events = new AbortController();
    if (longPress) target.classList.add('long-press');
    let cancelPress = () => {}, cancelRelease = () => {}, touch = false;
    target.addEventListener('contextmenu', event => {
        event.preventDefault(); event.stopPropagation();
        // Touch menus belong to the hold timer, including its release-click suppression.
        if (longPress && touch) return;
        cancelPress(); open({ x: event.clientX, y: event.clientY });
    }, { signal: events.signal });
    target.addEventListener('keydown', event => {
        cancelPress(); touch = false;
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
            event.preventDefault(); event.stopPropagation(); open();
        }
    }, { signal: events.signal });
    if (longPress) target.addEventListener('pointerdown', event => {
        touch = event.pointerType === 'touch' || event.pointerType === 'pen';
        if (!touch || !event.isPrimary || event.button !== 0) return;
        cancelPress(); cancelRelease();
        const press = new AbortController(), signal = press.signal;
        const timer = setTimeout(() => {
            cancelPress();
            // The menu may cover the pressed tab; consume release at document level.
            const release = new AbortController(), signal = release.signal;
            let releaseTimer: ReturnType<typeof setTimeout> | undefined;
            cancelRelease = () => { clearTimeout(releaseTimer); release.abort(); };
            const suppress = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
            document.addEventListener('click', suppress, { capture: true, signal });
            document.addEventListener('contextmenu', suppress, { capture: true, signal });
            window.addEventListener('pointerup', () => { releaseTimer = setTimeout(cancelRelease, 400); }, { capture: true, once: true, signal });
            window.addEventListener('pointerdown', cancelRelease, { capture: true, once: true, signal });
            window.addEventListener('pointercancel', cancelRelease, { capture: true, once: true, signal });
            window.addEventListener('keydown', e => { if (e.key !== 'Escape') cancelRelease(); }, { capture: true, signal });
            window.addEventListener('blur', cancelRelease, { signal });
            open({ x: event.clientX, y: event.clientY });
        }, 500);
        cancelPress = () => { clearTimeout(timer); press.abort(); };
        window.addEventListener('pointermove', e => {
            if (e.pointerId === event.pointerId && Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) > 10) cancelPress();
        }, { signal });
        for (const type of ['pointerup', 'pointercancel', 'pointerdown', 'blur', 'scroll', 'resize']) {
            window.addEventListener(type, cancelPress, { capture: true, signal });
        }
    }, { signal: events.signal });
    return () => { events.abort(); cancelPress(); cancelRelease(); target.classList.remove('long-press'); };
}
export function popover(anchor: HTMLElement | { x: number; y: number }, content: HTMLElement, returnFocus = document.activeElement as HTMLElement) {
    const control = anchor instanceof HTMLElement ? anchor : undefined;
    const parent = (control || returnFocus)?.closest<HTMLElement>('.popover-menu:popover-open');
    while (popovers.length && popovers.at(-1)!.content !== parent) popovers.at(-1)!.close();
    content.classList.add('popover-menu');
    // A right-click opens before pointerup; native light-dismiss would immediately close it.
    content.popover = control ? 'auto' : 'manual';
    if (!content.hasAttribute('role')) content.setAttribute('role', 'menu');
    const events = new AbortController();
    control?.setAttribute('aria-expanded', 'true');
    (parent || document.body).append(content);
    content.showPopover();
    const rect = control?.getBoundingClientRect();
    const left = rect ? rect.right - content.offsetWidth : (anchor as { x: number }).x;
    const top = rect ? rect.bottom + 4 : (anchor as { y: number }).y;
    content.style.left = `${Math.max(4, Math.min(left, innerWidth - content.offsetWidth - 4))}px`;
    content.style.top = `${Math.max(4, Math.min(top, innerHeight - content.offsetHeight - 4))}px`;
    const close = () => {
        if (!popovers.includes(popup)) return;
        while (popovers.at(-1) !== popup) popovers.at(-1)!.close();
        popovers.pop();
        if (content.contains(document.activeElement)) (control || returnFocus)?.focus({ preventScroll: true });
        if (content.matches(':popover-open')) content.hidePopover();
        content.remove(); events.abort(); control?.setAttribute('aria-expanded', 'false');
    };
    if (!control) document.addEventListener('pointerdown', event => { if (!content.contains(event.target as Node)) close(); }, { capture: true, signal: events.signal });
    content.addEventListener('toggle', event => { if (event.newState === 'closed') close(); }, { signal: events.signal });
    window.addEventListener('resize', close, { signal: events.signal });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && popovers.at(-1)?.content === content) { event.preventDefault(); close(); } }, { signal: events.signal });
    const popup = { content, close };
    popovers.push(popup);
    content.onkeydown = event => {
        if ((event.target as HTMLElement).closest('.popover-menu') !== content) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (content.getAttribute('role') !== 'menu') return;
        if (!["ArrowDown", 'ArrowUp', "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [...content.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(item => item.checkVisibility() && item.closest('.popover-menu') === content);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
    };
    content.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)')?.focus();
    return { close };
}
export function ask(title: string, label: string, initial = '', reset?: string): Promise<string | null> {
    return new Promise(resolve => {
        const form = el('form', 'form');
        form.method = 'dialog';
        const input = el('input');
        input.value = initial;
        input.required = true;
        input.maxLength = 4096;
        input.autofocus = true;
        const field = el('label', 'field', label);
        field.append(input);
        const actions = el('div', 'actions');
        const cancel = button(t("common.cancel"), undefined, () => dialog.close());
        const ok = button(t("common.continue"));
        ok.type = 'submit';
        ok.classList.add('primary');
        if (reset !== undefined) actions.append(button(t("common.reset"), undefined, () => { resolve(reset); dialog.close(); }));
        actions.append(cancel, ok);
        form.append(field, actions);
        const { dialog } = modal(title, form);
        form.onsubmit = e => { e.preventDefault(); resolve(input.value); dialog.close(); };
        dialog.addEventListener('close', () => resolve(null), { once: true });
        input.focus();
        input.select();
    });
}
export function confirmAction(title: string, message: string, action = t("common.continue")): Promise<boolean> {
    return new Promise(resolve => {
        const content = el('div', 'form');
        content.append(el('p', 'muted', message));
        const actions = el('div', 'actions');
        const { dialog } = modal(title, content);
        actions.append(button(t("common.cancel"), undefined, () => dialog.close()), button(action, undefined, () => { resolve(true); dialog.close(); }, 'primary'));
        content.append(actions);
        actions.querySelector<HTMLButtonElement>('.primary')!.focus();
        dialog.addEventListener('close', () => resolve(false), { once: true });
    });
}
export { size } from './monitor-values';
