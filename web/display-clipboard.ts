import type RFB from './vendor/novnc/core/rfb';
import { isMac, isIOS } from './vendor/novnc/core/util/browser';
import { api, button, el, modal, notificationHost, notify } from './ui';
import { clearFileCut, copyFiles, fileClipboardContent, readFileClipboard } from './file-clipboard';
import { type DraggedFile } from './file-drag';
import { downloadArchive } from './transfers';

// Retain the terminal clipboard's text bound; binary data travels through X11.
const maxBytes = 256 * 1024;
type Copy = { resolve: (text: Blob) => void; reject: (error: Error) => void; timer: number; cancelled: boolean; blocked: boolean; text?: string; version: number };

type NativeClipboard = { text?: string; png?: string; files?: string[] };
type ClipboardOptions = { path: string; uid: number; upload: (files: File[]) => Promise<DraggedFile[]>; disconnected: () => void };

export function displayClipboard(screen: HTMLElement, rfb: RFB, owner: HTMLElement, options: ClipboardOptions) {
    const events = new AbortController(), signal = events.signal;
    const modifiers = new Map<string, number>();
    let pending: Copy | undefined, fallback: HTMLElement | undefined, closeDialog: (() => void) | undefined;
    let version = 0, interacted = false, pasteShift = false, remoteVersion = -1, pasting = false;
    let reading: AbortController | undefined;
    const url = new URL('/api' + options.path + '/clipboard/events', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const changes = new WebSocket(url);
    const blobs = (data: NativeClipboard): Record<string, Blob> => {
        if (data.png) return { 'image/png': new Blob([Uint8Array.from(atob(data.png), c => c.charCodeAt(0))], { type: 'image/png' }) };
        if (data.files) {
            const content = fileClipboardContent(data.files.map(path => ({ path, name: path.split('/').pop()! })), options.uid);
            return { 'text/plain': new Blob([content.text], { type: 'text/plain' }), 'text/html': new Blob([content.html], { type: 'text/html' }) };
        }
        return { 'text/plain': new Blob([data.text || ''], { type: 'text/plain' }) };
    };
    const writeNative = (data: NativeClipboard) => {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return Promise.reject(new Error('Clipboard unavailable'));
        return navigator.clipboard.write([new ClipboardItem(blobs(data))]);
    };
    const focused = () => !signal.aborted && screen.isConnected && screen.getClientRects().length > 0 &&
        document.visibilityState === 'visible' && document.hasFocus() && screen.contains(document.activeElement);
    const valid = (text: string) => {
        // Keep the existing text limit, including Windows line endings.
        if (text.length <= maxBytes && new Blob([text.replace(/\r\n|\r|\n/g, '\r\n')]).size + 1 <= maxBytes) return true;
        notify('GUI clipboard text is too large (maximum 256 KB).', owner); return false;
    };
    const cancel = () => {
        if (!pending) return;
        const copy = pending; pending = undefined; copy.cancelled = true;
        clearTimeout(copy.timer); copy.reject(new Error('Copy cancelled'));
    };
    const offer = (data: NativeClipboard, current: number) => {
        const text = data.text || '';
        if (signal.aborted || current !== version) return;
        fallback?.remove();
        const copy = button('Copy to device', 'Copy', async () => {
            if (data.png) {
                try { await writeNative(data); clearFileCut(); fallback?.remove(); rfb.focus(); }
                catch { notify('Image copying needs clipboard permission and HTTPS or localhost. You can download the image instead.', owner); }
                return;
            }
            if (data.files) {
                copyFiles(data.files.map(path => ({ path, name: path.split('/').pop()! })), options.uid, false);
                fallback?.remove(); rfb.focus(); return;
            }
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
        fallback.append(copy);
        if (data.png || data.files) {
            const save = button(data.png ? 'Download image' : 'Download files', 'Download', async () => {
                if (data.png) {
                    const url = URL.createObjectURL(blobs(data)['image/png']), link = el('a');
                    link.href = url; link.download = 'clipboard-image.png'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
                } else {
                    const groups = new Map<string, string[]>();
                    for (const path of data.files!) { const parent = path.slice(0, path.lastIndexOf('/')) || '/'; groups.set(parent, [...groups.get(parent) || [], path]); }
                    for (const [parent, paths] of groups) await downloadArchive(parent, paths, owner);
                }
            });
            save.append(el('span', '', data.png ? 'Download image' : 'Download files')); fallback.append(save);
        }
        fallback.append(button('Dismiss', 'X', () => fallback?.remove()));
        notificationHost('notifications', owner).append(fallback);
    };
    const shortcut = (letter: string, shift: boolean) => {
        // Temporarily release physical modifiers, including noVNC's Command→Alt mapping.
        for (const [code, keysym] of modifiers) rfb.sendKey(keysym, code, false);
        rfb.sendKey(0xffe3, 'ControlLeft', true);
        if (shift) rfb.sendKey(0xffe1, 'ShiftLeft', true);
        rfb.sendKey((shift ? letter.toUpperCase() : letter).charCodeAt(0), 'Key' + letter.toUpperCase());
        if (shift) rfb.sendKey(0xffe1, 'ShiftLeft', false);
        rfb.sendKey(0xffe3, 'ControlLeft', false);
        for (const [code, keysym] of modifiers) rfb.sendKey(keysym, code, true);
    };
    const copy = (letter: string, shift: boolean) => {
        // Ctrl+C may be a terminal interrupt inside the remote application.
        if (pasting || remoteVersion < 0) { shortcut(letter, shift); return; }
        cancel();
        interacted = true; fallback?.remove();
        let operation!: Copy;
        const content = new Promise<Blob>((resolve, reject) => {
            operation = { resolve, reject, version: ++version, cancelled: false, blocked: false, timer: window.setTimeout(() => {
                cancel(); interacted = false;
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
                    if (!operation.cancelled && operation.text !== undefined) offer({ text: operation.text }, operation.version);
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
    const paste = async (data: NativeClipboard, shift: boolean, current: number) => {
        await api(options.path + '/clipboard', 'POST', data, signal);
        if (focused() && version === current) shortcut('v', shift);
    };
    screen.addEventListener('paste', event => {
        if (!(event.target instanceof HTMLCanvasElement) || !event.clipboardData) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!focused() || pasting) return;
        cancel(); const current = ++version; fallback?.remove(); interacted = false;
        const clipboard = event.clipboardData, shift = pasteShift; pasteShift = false;
        // Capture protected DataTransfer contents before the event returns.
        const files = Array.from(clipboard.files), text = clipboard.getData('text/plain'), hasText = clipboard.types.includes('text/plain');
        let record: ReturnType<typeof readFileClipboard>;
        try { if (!files.length) record = readFileClipboard(clipboard, options.uid); }
        catch (error) { notify(error, owner); return; }
        pasting = true;
        void (async () => {
            if (files.length === 1 && files[0].type === 'image/png' && /^(image|clipboard-image)\.png$/i.test(files[0].name)) {
                if (files[0].size > 16 * 1024 * 1024) throw new Error('Clipboard image exceeds 16 MB.');
                const png = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(files[0]); });
                await paste({ png }, shift, current);
            } else if (files.length) {
                const uploaded = await options.upload(files);
                if (focused() && version === current && uploaded.length) await paste({ files: uploaded.map(file => file.path) }, shift, current);
            } else if (record) {
                // Cross-application cuts have no trustworthy completion acknowledgement.
                clearFileCut(); await paste({ files: record.paths }, shift, current);
                if (record.action === 'cut') notify('Files pasted as copies; originals were kept.', owner);
            } else if (hasText && valid(text)) await paste({ text }, shift, current);
            else if (!hasText) notify('The browser did not provide a supported image, file or text clipboard.', owner);
        })().catch(error => { if (!signal.aborted) notify(error, owner); }).finally(() => { pasting = false; });
    }, { capture: true, signal });
    // Browser Edit menus can issue copy/cut without a keydown.
    for (const type of ['copy', 'cut']) screen.addEventListener(type, event => {
        if (!(event.target instanceof HTMLCanvasElement) || !focused()) return;
        event.preventDefault(); event.stopImmediatePropagation(); copy(type === 'copy' ? 'c' : 'x', false);
    }, { signal });
    screen.addEventListener('pointerdown', () => { interacted = true; }, { signal });
    const lostFocus = () => {
        cancel(); version++; reading?.abort(); interacted = false; pasteShift = false;
        for (const [code, keysym] of modifiers) rfb.sendKey(keysym, code, false);
        modifiers.clear();
    };
    screen.addEventListener('focusout', lostFocus, { signal });
    window.addEventListener('blur', lostFocus, { signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) lostFocus(); }, { signal });
    changes.addEventListener('message', event => {
        const change = JSON.parse(event.data) as { version: number; local: boolean };
        const initial = remoteVersion < 0; remoteVersion = change.version;
        screen.dataset.clipboardReady = 'true';
        if (initial || change.local || pasting || !focused() || !interacted) return;
        reading?.abort(); const request = reading = new AbortController();
        const current = pending?.version ?? ++version;
        void api<NativeClipboard>(options.path + '/clipboard?version=' + change.version, 'GET', undefined, request.signal).then(data => {
            if (!focused() || !interacted || request.signal.aborted || current !== version) return;
            clearFileCut(); fallback?.remove();
            if (data.text !== undefined || !data.png && !data.files) {
                const text = data.text || ''; if (!valid(text)) { cancel(); return; }
                if (pending) {
                    const operation = pending; pending = undefined; clearTimeout(operation.timer);
                    operation.text = text; operation.resolve(new Blob([text], { type: 'text/plain' }));
                    if (operation.blocked) offer({ text }, current);
                } else if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).catch(() => offer({ text }, current));
                else offer({ text }, current);
            } else {
                // Format is known only after the remote app copies. Browsers requiring a
                // new gesture get an explicit button instead of an empty text clipboard.
                cancel();
                void writeNative(data).then(() => { if (data.files) offer(data, current); }).catch(() => offer(data, current));
            }
        }).catch(error => { if (!request.signal.aborted && focused() && current === version) { cancel(); notify(error, owner); } });
    }, { signal });
    changes.addEventListener('close', () => { if (!signal.aborted) { cancel(); delete screen.dataset.clipboardReady; remoteVersion = -1; options.disconnected(); } }, { signal });
    return {
        pastePaths: async (files: DraggedFile[]) => {
            const text = files.map(file => file.path).join('\n'); if (!valid(text)) return;
            cancel(); rfb.focus(); interacted = false; const current = ++version;
            await paste({ text }, false, current);
        },
        dispose: () => {
            lostFocus(); events.abort(); changes.close(); version++; fallback?.remove(); closeDialog?.(); delete screen.dataset.clipboardReady;
        }
    };
}
