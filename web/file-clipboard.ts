import { APIError } from './ui';
import { id } from './model';
import { shellPaths, type DraggedFile } from './file-drag';

type FileClipboard = { version: 1; id: string; origin: string; uid: number; action: 'copy' | 'cut'; paths: string[] };
type PendingCut = { data: FileClipboard; remaining: Set<string>; busy: boolean };
// shortcut: cuts belong to this page; synchronize only if cross-tab cuts are required.
let pendingCut: PendingCut | undefined;
const changed = (path?: string) => window.dispatchEvent(new CustomEvent('tuxee-file-cut', { detail: path }));
export function clearFileCut() { if (pendingCut) { pendingCut = undefined; changed(); } }
export function isFileCut(path: string, uid: number) { return pendingCut?.data.uid === uid && pendingCut.remaining.has(path); }
for (const type of ['copy', 'cut']) document.addEventListener(type, clearFileCut);

export function copyFiles(files: DraggedFile[], uid: number, cut: boolean, event?: ClipboardEvent) {
    if (!files.length) throw new Error('Select files first');
    const data: FileClipboard = { version: 1, id: id(), origin: location.origin, uid, action: cut ? 'cut' : 'copy', paths: files.map(file => file.path) };
    const text = shellPaths(files), node = document.createElement('span');
    node.dataset.tuxeeFiles = JSON.stringify(data); node.textContent = text;
    // HTML carries metadata through both clipboard events and the async menu API.
    const html = node.outerHTML;
    if (html.length > 8 * 1024 * 1024) throw new Error('Too many paths to copy');
    let written = false, error: unknown;
    const write = (event: ClipboardEvent) => {
        event.preventDefault(); event.stopImmediatePropagation();
        try {
            if (!event.clipboardData) throw new Error('Clipboard unavailable');
            event.clipboardData.setData('text/plain', text);
            event.clipboardData.setData('text/html', html);
            written = true;
        } catch (value) { error = value; }
    };
    if (event) write(event);
    else {
        // Native copy events also work on ordinary HTTP, where navigator.clipboard is absent.
        document.addEventListener('copy', write, { capture: true });
        try { document.execCommand('copy'); }
        finally { document.removeEventListener('copy', write, true); }
    }
    if (!written) throw error || new Error('Could not copy files. Use Ctrl+C or ⌘C.');
    pendingCut = cut ? { data, remaining: new Set(data.paths), busy: false } : undefined;
    changed();
}

export function readFileClipboard(clipboard: DataTransfer, uid: number): FileClipboard | undefined {
    const html = clipboard.getData('text/html');
    if (!html.includes('data-tuxee-files')) { clearFileCut(); return; }
    if (html.length > 8 * 1024 * 1024) throw new Error('Clipboard file list is too large');
    const template = document.createElement('template');
    template.innerHTML = html;
    const nodes = template.content.querySelectorAll<HTMLElement>('[data-tuxee-files]');
    let data: FileClipboard;
    try {
        if (nodes.length !== 1) throw new Error();
        data = JSON.parse(nodes[0].dataset.tuxeeFiles!);
        if (!data || data.version !== 1 || typeof data.id !== 'string' || !/^[a-f0-9]{32}$/.test(data.id) ||
            !['copy', 'cut'].includes(data.action) || !Number.isSafeInteger(data.uid) || data.uid < 0 ||
            typeof data.origin !== 'string' || !Array.isArray(data.paths) || !data.paths.length || data.paths.length > 10000 ||
            data.paths.some(path => typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') ||
                path.slice(1).split('/').some(part => !part || part === '.' || part === '..')) ||
            new Set(data.paths).size !== data.paths.length ||
            clipboard.getData('text/plain') !== shellPaths(data.paths.map(path => ({ path, name: '' })))) throw new Error();
    } catch { throw new Error('Invalid Tuxee file clipboard'); }
    if (data.origin !== location.origin || data.uid !== uid) throw new Error('These files belong to another server or account');
    if (pendingCut && (pendingCut.data.id !== data.id || data.action === 'copy')) clearFileCut();
    return data;
}

export async function pasteFiles(data: FileClipboard, transfer: (files: DraggedFile[], operation: 'copy' | 'move', settled?: (path: string, error?: unknown) => void) => Promise<unknown>) {
    if (data.action === 'copy') {
        await transfer(data.paths.map(path => ({ path, name: path.split('/').pop()! })), 'copy');
        return;
    }
    const cut = pendingCut;
    if (!cut || cut.data.id !== data.id || cut.data.paths.length !== data.paths.length ||
        cut.data.paths.some((path, index) => path !== data.paths[index]) || !cut.remaining.size)
        throw new Error('This cut has ended. Cut the files again.');
    if (cut.busy) throw new Error('These files are already being moved');
    cut.busy = true;
    try {
        const files = data.paths.filter(path => cut.remaining.has(path)).map(path => ({ path, name: path.split('/').pop()! }));
        await transfer(files, 'move', (path, error) => {
            // A lost response or cancellation may follow a committed move; never replay it.
            if (!(error instanceof APIError) || error.status >= 500) {
                cut.remaining.delete(path); changed(path);
            }
        });
    } finally { cut.busy = false; }
}

export async function readDeviceClipboard(): Promise<DataTransfer> {
    if (!navigator.clipboard?.read) throw new Error('Use Ctrl+V or ⌘V to paste');
    let items: ClipboardItem[];
    try { items = await navigator.clipboard.read(); }
    catch { throw new Error('Clipboard access denied. Use Ctrl+V or ⌘V to paste.'); }
    const data = new DataTransfer();
    for (const item of items) {
        for (const type of ['text/plain', 'text/html']) {
            if (!item.types.includes(type)) continue;
            const blob = await item.getType(type);
            if (blob.size > 8 * 1024 * 1024) throw new Error('Clipboard file list is too large');
            data.setData(type, await blob.text());
        }
        if (item.types.includes('image/png')) data.items.add(new File([await item.getType('image/png')], 'clipboard-image.png', { type: 'image/png' }));
    }
    return data;
}
