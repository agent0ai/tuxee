import type RFB from './vendor/novnc/core/rfb';
import { isMac, isIOS } from './vendor/novnc/core/util/browser';
import { button, el, modal, notificationHost, notify } from './ui';
import { clearFileCut } from './file-clipboard';

// noVNC exchanges text only; keep within TigerVNC's 256 KiB clipboard limit.
const maxBytes = 256 * 1024;
type Copy = { resolve: (text: Blob) => void; reject: (error: Error) => void; timer: number; cancelled: boolean; blocked: boolean; text?: string; version: number };

export function displayClipboard(screen: HTMLElement, rfb: RFB, owner: HTMLElement) {
    const events = new AbortController(), signal = events.signal;
    const modifiers = new Map<string, number>();
    let pending: Copy | undefined, fallback: HTMLElement | undefined, closeDialog: (() => void) | undefined;
    let version = 0, interacted = false, pasteShift = false;
    const focused = () => !signal.aborted && screen.isConnected && screen.getClientRects().length > 0 &&
        document.visibilityState === 'visible' && document.hasFocus() && screen.contains(document.activeElement);
    const valid = (text: string) => {
        // Extended RFB adds CRLFs and a terminating NUL before encoding UTF-8.
        if (text.length <= maxBytes && new Blob([text.replace(/\r\n|\r|\n/g, '\r\n')]).size + 1 <= maxBytes) return true;
        notify('GUI clipboard text is too large (maximum 256 KB).', owner); return false;
    };
    const cancel = () => {
        if (!pending) return;
        const copy = pending; pending = undefined; copy.cancelled = true;
        clearTimeout(copy.timer); copy.reject(new Error('Copy cancelled'));
    };
    const offer = (text: string, current: number) => {
        if (signal.aborted || current !== version) return;
        fallback?.remove();
        const copy = button('Copy to device', 'Copy', () => {
            let written = false;
            const write = (event: ClipboardEvent) => {
                if (!event.clipboardData) return;
                event.preventDefault(); event.stopImmediatePropagation();
                event.clipboardData.setData('text/plain', text); written = true;
            };
            document.addEventListener('copy', write, { capture: true });
            try { document.execCommand('copy'); }
            finally { document.removeEventListener('copy', write, true); }
            if (written) { clearFileCut(); fallback?.remove(); rfb.focus(); return; }
            const input = el('textarea'); input.value = text; input.readOnly = true;
            input.setAttribute('aria-label', 'Text to copy');
            closeDialog?.();
            ({ close: closeDialog } = modal('Copy to device', input)); input.focus(); input.select();
        });
        copy.append(el('span', '', 'Copy to device'));
        fallback = el('div', 'toast'); fallback.setAttribute('role', 'status');
        fallback.append(copy, button('Dismiss', 'X', () => fallback?.remove()));
        notificationHost('notifications', owner).append(fallback);
    };
    const shortcut = (letter: string, shift: boolean) => {
        // Temporarily release physical modifiers, including noVNC's Command→Alt mapping.
        for (const [code, keysym] of modifiers) rfb.sendKey(keysym, code, false);
        rfb.sendKey(0xffe3, 'ControlLeft', true);
        if (shift) rfb.sendKey(0xffe1, 'ShiftLeft', true);
        rfb.sendKey(letter.charCodeAt(0), 'Key' + letter.toUpperCase());
        if (shift) rfb.sendKey(0xffe1, 'ShiftLeft', false);
        rfb.sendKey(0xffe3, 'ControlLeft', false);
        for (const [code, keysym] of modifiers) rfb.sendKey(keysym, code, true);
    };
    const copy = (letter: string, shift: boolean) => {
        if (pending) { notify('Waiting for the application to copy text.', owner); return; }
        interacted = true; fallback?.remove(); clearFileCut();
        let operation!: Copy;
        const content = new Promise<Blob>((resolve, reject) => {
            operation = { resolve, reject, version: ++version, cancelled: false, blocked: false, timer: window.setTimeout(() => {
                cancel(); interacted = false; notify('No text was copied. Select text and try again.', owner);
            }, 10000) };
        });
        pending = operation;
        // A denied write may reject before the application supplies its clipboard.
        void content.catch(() => {});
        if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
            try {
                // Start in the gesture; Safari can receive the remote text through the promise.
                void navigator.clipboard.write([new ClipboardItem({ 'text/plain': content })]).catch(() => {
                    operation.blocked = true;
                    if (!operation.cancelled && operation.text !== undefined) offer(operation.text, operation.version);
                });
            } catch { operation.blocked = true; }
        } else operation.blocked = true;
        shortcut(letter, shift);
    };
    screen.addEventListener('keydown', event => {
        if (!(event.target instanceof HTMLCanvasElement)) return;
        const mac = isMac() || isIOS();
        const keys: Record<string, number> = { ControlLeft: 0xffe3, ControlRight: 0xffe4, ShiftLeft: 0xffe1, ShiftRight: 0xffe2,
            MetaLeft: mac ? 0xffe9 : 0xffeb, MetaRight: mac ? 0xffeb : 0xffec };
        if (keys[event.code]) modifiers.set(event.code, keys[event.code]);
        interacted = true;
        if (event.altKey || !(mac ? event.metaKey || event.ctrlKey : event.ctrlKey) || !['KeyC', 'KeyX', 'KeyV'].includes(event.code)) return;
        event.stopImmediatePropagation();
        if (event.code === 'KeyV') { pasteShift = event.shiftKey; return; } // Preserve the browser's native paste event.
        event.preventDefault();
        if (!event.repeat) copy(event.code === 'KeyC' ? 'c' : 'x', event.shiftKey);
    }, { capture: true, signal });
    screen.addEventListener('keyup', event => {
        modifiers.delete(event.code);
        if (event.code === 'KeyV') pasteShift = false;
    }, { capture: true, signal });
    screen.addEventListener('paste', event => {
        if (!(event.target instanceof HTMLCanvasElement) || !event.clipboardData) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!focused()) return;
        cancel(); version++; fallback?.remove(); interacted = false;
        if (!event.clipboardData.types.includes('text/plain')) { notify('GUI clipboard supports text only.', owner); return; }
        const text = event.clipboardData.getData('text/plain');
        if (!valid(text)) return;
        rfb.clipboardPasteFrom(text); shortcut('v', pasteShift); pasteShift = false;
    }, { capture: true, signal });
    // Browser Edit menus can issue copy/cut without a keydown.
    for (const type of ['copy', 'cut']) screen.addEventListener(type, event => {
        if (!(event.target instanceof HTMLCanvasElement) || !focused()) return;
        event.preventDefault(); event.stopImmediatePropagation(); copy(type === 'copy' ? 'c' : 'x', false);
    }, { signal });
    screen.addEventListener('pointerdown', () => { interacted = true; }, { signal });
    const lostFocus = () => {
        cancel(); interacted = false; pasteShift = false;
        for (const [code, keysym] of modifiers) rfb.sendKey(keysym, code, false);
        modifiers.clear();
    };
    screen.addEventListener('focusout', lostFocus, { signal });
    window.addEventListener('blur', lostFocus, { signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) lostFocus(); }, { signal });
    const received = (event: Event) => {
        const text = (event as CustomEvent<{ text: string }>).detail.text;
        if (!focused() || !interacted) return;
        if (!valid(text)) { cancel(); return; }
        if (pending) {
            const operation = pending; pending = undefined; clearTimeout(operation.timer);
            operation.text = text; operation.resolve(new Blob([text], { type: 'text/plain' }));
            if (operation.blocked) offer(text, operation.version);
        } else {
            const current = ++version;
            clearFileCut(); fallback?.remove();
            // Remote application menus have no synchronous browser copy event.
            if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).catch(() => offer(text, current));
            else offer(text, current);
        }
    };
    rfb.addEventListener('clipboard', received);
    return () => {
        lostFocus(); events.abort(); version++; fallback?.remove(); closeDialog?.();
        rfb.removeEventListener('clipboard', received);
    };
}
