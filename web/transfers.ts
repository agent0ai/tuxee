import { api, button, el, notificationHost, requestHeaders, size } from './ui';
import { id as newID, join } from './model';
import type { DraggedFile } from './file-drag';
type Transfer = {
    node: HTMLElement;
    name: string;
    progress: HTMLProgressElement;
    label: HTMLElement;
    cancel: HTMLButtonElement;
    abort: () => void;
};
const transfers = new Map<string, Transfer>();
function create(id: string, name: string, abort: () => void, owner?: HTMLElement): Transfer {
    const node = el('div', 'transfer');
    const label = el('span', 'transfer-label', name), progress = el('progress');
    progress.max = 100;
    progress.value = 0;
    const cancel = button('Cancel transfer', 'X', abort);
    node.append(label, progress, cancel);
    notificationHost('transfers', owner).append(node);
    const value = { node, name, progress, label, cancel, abort };
    transfers.set(id, value);
    return value;
}
function finish(id: string, error?: string) { const value = transfers.get(id); if (!value)
    return; value.cancel.disabled = true; if (!error) value.progress.value = 100; value.label.textContent += error ? ` · ${error}` : ' · Done'; value.node.classList.toggle('failed', !!error); transfers.delete(id); setTimeout(() => value.node.remove(), error ? 12000 : 3000); }
export function cancelTransfers() { for (const value of transfers.values())
    value.abort(); }
export async function operation(name: string, total: number, work: (signal: AbortSignal, progress: (done: number) => void) => Promise<void>, owner?: HTMLElement) {
    const id = newID(), controller = new AbortController();
    const view = create(id, name, () => controller.abort(), owner);
    try {
        await work(controller.signal, done => { view.progress.value = done / total * 100; view.label.textContent = `${name} · ${done}/${total}`; });
        finish(id);
    } catch (error) { finish(id, controller.signal.aborted ? 'Cancelled' : error instanceof Error ? error.message : 'Failed'); throw error; }
}
export async function upload(path: string, file: File, signal: AbortSignal, unique = false, progress?: (loaded: number) => void): Promise<string> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest(), abort = () => xhr.abort();
        xhr.open('POST', `/api/upload?path=${encodeURIComponent(path)}&unique=${unique}`);
        for (const [name, value] of Object.entries(requestHeaders())) xhr.setRequestHeader(name, value);
        xhr.setRequestHeader('X-Tuxee-Size', String(file.size));
        xhr.upload.onprogress = event => { if (event.lengthComputable) progress?.(Math.min(event.loaded, file.size)); };
        xhr.onload = () => {
            try {
                const result = JSON.parse(xhr.responseText);
                if (xhr.status < 200 || xhr.status >= 300) throw new Error(result.error || 'Upload failed');
                resolve(result.path);
            } catch (error) { reject(error); }
        };
        xhr.onerror = () => reject(new Error('Upload connection failed'));
        xhr.onabort = () => reject(new Error('Upload cancelled'));
        xhr.onloadend = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        xhr.send(file);
    });
}
export type UploadSource = File | FileSystemEntry;
type UploadItem = { name: string; file?: File; children?: UploadItem[] };
export async function uploadBatch(destination: string, sources: UploadSource[], owner: HTMLElement, lifetime: AbortSignal, ensureDirectory = false): Promise<DraggedFile[]> {
    if (!sources.length) return [];
    lifetime.throwIfAborted();
    const id = newID(), controller = new AbortController(), abort = () => controller.abort();
    const signal = controller.signal, view = create(id, 'Reading files…', abort, owner);
    lifetime.addEventListener('abort', abort, { once: true });
    view.progress.removeAttribute('value');
    let total = 0, bytes = 0, completed = 0, sent = 0;
    const update = (loaded = 0) => {
        view.label.textContent = `Uploading · ${completed}/${total} files · ${size(sent + loaded)} / ${size(bytes)}`;
        view.progress.value = bytes ? (sent + loaded) / bytes * 100 : total ? completed / total * 100 : 0;
    };
    async function collect(source: UploadSource): Promise<UploadItem> {
        signal.throwIfAborted();
        if (!source.name || source.name === '.' || source.name === '..' || /[/\0]/.test(source.name)) throw new Error('Invalid upload name');
        if (!(source instanceof File) && source.isDirectory) {
            const children: UploadItem[] = [], reader = (source as FileSystemDirectoryEntry).createReader();
            while (true) {
                signal.throwIfAborted();
                const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
                if (!entries.length) break;
                for (const entry of entries) children.push(await collect(entry));
            }
            return { name: source.name, children };
        }
        const file = source instanceof File ? source : await new Promise<File>((resolve, reject) => (source as FileSystemFileEntry).file(resolve, reject));
        signal.throwIfAborted();
        total++; bytes += file.size;
        return { name: file.name, file };
    }
    async function send(parent: string, item: UploadItem): Promise<DraggedFile> {
        signal.throwIfAborted();
        let path = join(parent, item.name);
        if (item.children) {
            ({ path } = await api<{ path: string }>('/files', 'POST', { operation: 'mkdir', path, unique: true }, signal));
            for (const child of item.children) await send(path, child);
        } else {
            path = await upload(path, item.file!, signal, true, update);
            sent += item.file!.size; completed++; update();
        }
        return { path, name: path.slice(path.lastIndexOf('/') + 1), directory: !!item.children };
    }
    try {
        const items: UploadItem[] = [];
        for (const source of sources) items.push(await collect(source));
        signal.throwIfAborted(); update();
        if (ensureDirectory) await api('/files', 'POST', { operation: 'mkdir', path: destination, parents: true }, signal);
        const uploaded: DraggedFile[] = [];
        for (const item of items) uploaded.push(await send(destination, item));
        finish(id);
        return uploaded;
    } catch (error) {
        finish(id, signal.aborted ? 'Cancelled' : error instanceof Error ? error.message : 'Upload failed');
        throw error;
    } finally { lifetime.removeEventListener('abort', abort); }
}
let workerReady: Promise<boolean> | undefined;
export function prepareDownloads() {
    return workerReady ??= (async () => {
        if (!('serviceWorker' in navigator) || !isSecureContext)
            return false;
        try {
            await navigator.serviceWorker.register('/sw.js');
            await navigator.serviceWorker.ready;
            if (!navigator.serviceWorker.controller)
                await new Promise<void>(resolve => { const timeout = setTimeout(resolve, 3000); navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timeout); resolve(); }, { once: true }); });
            navigator.serviceWorker.addEventListener('message', event => {
                const { id, loaded, total, done, error } = event.data || {};
                const value = transfers.get(id);
                if (!value)
                    return;
                if (total) {
                    value.progress.value = loaded / total * 100;
                    value.label.textContent = `${value.name} · ${size(loaded)} / ${size(total)}`;
                }
                if (done || error)
                    finish(id, error);
            });
            return !!navigator.serviceWorker.controller;
        }
        catch {
            return false;
        }
    })();
}
export async function download(path: string, name: string, owner?: HTMLElement) {
    const supported = await prepareDownloads(), id = newID();
    if (supported) {
        await new Promise<void>((resolve, reject) => {
            const channel = new MessageChannel(), timer = setTimeout(() => { channel.port1.close(); reject(new Error('Download worker did not respond')); }, 3000);
            channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); event.data.error ? reject(new Error(event.data.error)) : resolve(); };
            navigator.serviceWorker.controller!.postMessage({ start: id }, [channel.port2]);
        });
        create(id, `Downloading ${name}`, () => navigator.serviceWorker.controller?.postMessage({ cancel: id }), owner);
    }
    const link = el('a');
    link.href = `/api/download?path=${encodeURIComponent(path)}&transfer=${id}`;
    // Content-Disposition starts the download; the download attribute bypasses service workers in Chromium.
    document.body.append(link);
    link.click();
    link.remove();
}
export async function downloadArchive(path: string, paths: string[], owner?: HTMLElement) {
    const id = newID(), controller = new AbortController();
    const view = create(id, 'Zipping & downloading · 0 B ZIP', () => controller.abort(), owner);
    view.node.classList.add('archive-transfer');
    view.progress.removeAttribute('value');
    let token = '', frame: HTMLIFrameElement | undefined;
    try {
        const prepared = await api<{ token: string; name: string }>('/download-archive', 'POST', { path, paths }, controller.signal);
        token = prepared.token;
        controller.signal.throwIfAborted();
        frame = el('iframe'); frame.hidden = true;
        frame.src = `/api/download?archive=${encodeURIComponent(token)}`;
        document.body.append(frame);
        while (!controller.signal.aborted) {
            const status = await api<{ size: number; done: boolean; error?: string }>(`/download-archive?token=${encodeURIComponent(token)}`, 'GET', undefined, controller.signal);
            view.label.textContent = `Zipping & downloading ${prepared.name} · ${size(status.size)} ZIP`;
            if (status.error) throw new Error(status.error);
            if (status.done) { finish(id); return; }
            await new Promise<void>(resolve => setTimeout(resolve, 400));
        }
        controller.signal.throwIfAborted();
    } catch (error) {
        finish(id, controller.signal.aborted ? 'Cancelled' : error instanceof Error ? error.message : 'Download failed');
    } finally {
        frame?.remove();
        if (token) await api(`/download-archive?token=${encodeURIComponent(token)}`, 'DELETE').catch(() => {});
    }
}
