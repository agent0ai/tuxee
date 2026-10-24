import { el, icon } from './ui';
import type { UploadSource } from './transfers';
export type DraggedFile = { path: string; name: string; directory?: boolean };
export type FileDrop = { source: string; files: DraggedFile[]; copy: boolean; target: Element; clientX: number; clientY: number };
type DropTarget = { over: (drop: FileDrop) => boolean; leave: () => void; drop: (drop: FileDrop) => void };
const targets = new WeakMap<Element, DropTarget>();
export function setDropFeedback(node: HTMLElement, label?: string) {
    // Retain the text while the component-bound overlay fades out.
    if (label) node.dataset.dropLabel = node.dataset.drop = label;
    else delete node.dataset.drop;
}
export function preventFileNavigation() {
    for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
        const data = (event as DragEvent).dataTransfer;
        if (!data?.types.includes('Files')) return;
        event.preventDefault();
        data.dropEffect = 'none';
    }, { capture: true });
}

// Capture protected drop/clipboard data synchronously before the event returns.
function uploadSources(data: DataTransfer, clipboard = false): UploadSource[] {
    const sources: UploadSource[] = [];
    for (const item of data.items) {
        if (item.kind !== 'file') continue;
        const source = !clipboard && item.webkitGetAsEntry?.() || item.getAsFile();
        if (source) sources.push(source);
    }
    if (!data.items.length) sources.push(...data.files);
    return sources.map(source => {
        if (clipboard && source instanceof File && source.type.startsWith('image/') && /^image\.[a-z0-9]+$/i.test(source.name)) {
            return new File([source], `clipboard-image.${source.name.split('.').pop()}`, { type: source.type });
        }
        return source;
    });
}

export function registerUploadInput(node: HTMLElement, handlers: {
    accept: () => boolean;
    over: () => void;
    leave: () => void;
    upload: (sources: UploadSource[], point?: { clientX: number; clientY: number }) => void;
    paste?: (data: DataTransfer) => boolean;
}, signal: AbortSignal) {
    const paste = (data: DataTransfer) => {
        const sources = uploadSources(data, true);
        if (sources.length) {
            if (handlers.accept()) handlers.upload(sources);
            return true;
        }
        return handlers.accept() && !!handlers.paste?.(data);
    };
    node.addEventListener('dragover', event => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault(); event.stopPropagation();
        const accepted = handlers.accept();
        event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
        if (accepted) handlers.over(); else handlers.leave();
    }, { signal });
    node.addEventListener('dragleave', event => {
        if (!node.contains(event.relatedTarget as Node)) handlers.leave();
    }, { signal });
    node.addEventListener('drop', event => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault(); event.stopPropagation(); handlers.leave();
        if (handlers.accept()) handlers.upload(uploadSources(event.dataTransfer), { clientX: event.clientX, clientY: event.clientY });
    }, { signal });
    node.addEventListener('paste', event => {
        const target = event.target as Element;
        if (target.closest('.terminal-display')) return;
        if (target.closest('input:not([type=checkbox]), textarea, [contenteditable]') && !target.classList.contains('xterm-helper-textarea')) return;
        if (!event.clipboardData) return;
        if (!paste(event.clipboardData)) return;
        event.preventDefault(); event.stopImmediatePropagation();
    }, { signal, capture: true });
    signal.addEventListener('abort', handlers.leave, { once: true });
    return paste;
}

export function registerFileDrop(node: HTMLElement, handlers: DropTarget, signal: AbortSignal) {
    targets.set(node, handlers);
    signal.addEventListener('abort', () => { handlers.leave(); targets.delete(node); }, { once: true });
}
export function fileGroupLabel(files: DraggedFile[]): string {
    if (files.length === 1) return files[0].name;
    const folders = files.filter(file => file.directory).length, count = files.length - folders;
    return [folders ? `${folders} folder${folders === 1 ? '' : 's'}` : '', count ? `${count} file${count === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
}
export function startFileDrag(event: PointerEvent, source: string, selection: () => DraggedFile[], lifetime: AbortSignal) {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    // Internal drags must not enter AppKit's native modifier/operation negotiation.
    event.preventDefault();
    const trigger = event.currentTarget as HTMLElement, events = new AbortController();
    const group = el('div', 'file-drag-group');
    let files: DraggedFile[] | undefined, receiver: DropTarget | undefined, drop: FileDrop | undefined;
    let x = event.clientX, y = event.clientY, copy = event.ctrlKey || event.metaKey || event.altKey, accepted = false;
    trigger.focus({ preventScroll: true }); trigger.setPointerCapture(event.pointerId);
    function update() {
        if (!files) return;
        Object.assign(group.style, { left: `${x + 12}px`, top: `${y + 12}px` });
        const target = document.elementFromPoint(x, y);
        let node = target, next: DropTarget | undefined;
        while (node && !(next = targets.get(node))) node = node.parentElement;
        if (next !== receiver) receiver?.leave();
        receiver = next;
        drop = target ? { source, files, copy, target, clientX: x, clientY: y } : undefined;
        accepted = !!(drop && receiver?.over(drop));
        group.classList.toggle('invalid', !accepted);
    }
    function finish(commit = false) {
        events.abort(); lifetime.removeEventListener('abort', cancel);
        receiver?.leave(); group.remove();
        if (trigger.hasPointerCapture(event.pointerId)) trigger.releasePointerCapture(event.pointerId);
        if (files) {
            const suppress = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
            document.addEventListener('click', suppress, { capture: true, once: true });
            setTimeout(() => document.removeEventListener('click', suppress, true), 0);
        }
        if (commit && accepted && drop) receiver?.drop(drop);
    }
    const cancel = () => finish();
    lifetime.addEventListener('abort', cancel, { once: true });
    trigger.addEventListener('pointermove', move => {
        x = move.clientX; y = move.clientY; copy = move.ctrlKey || move.metaKey || move.altKey;
        if (!files && Math.hypot(x - event.clientX, y - event.clientY) >= 5) {
            files = selection();
            group.append(icon(files.every(file => file.directory) ? 'Folder' : 'File'), el('span', 'file-drag-label', fileGroupLabel(files)));
            document.body.append(group);
        }
        update();
    }, { signal: events.signal });
    trigger.addEventListener('pointerup', up => { x = up.clientX; y = up.clientY; copy = up.ctrlKey || up.metaKey || up.altKey; update(); finish(true); }, { signal: events.signal });
    trigger.addEventListener('pointercancel', cancel, { signal: events.signal });
    trigger.addEventListener('lostpointercapture', cancel, { signal: events.signal });
    window.addEventListener('blur', cancel, { signal: events.signal });
    document.addEventListener('contextmenu', e => { e.preventDefault(); e.stopImmediatePropagation(); }, { capture: true, signal: events.signal });
    const key = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
        if (files) { e.preventDefault(); e.stopPropagation(); }
        copy = e.ctrlKey || e.metaKey || e.altKey; update();
    };
    document.addEventListener('keydown', key, { capture: true, signal: events.signal });
    document.addEventListener('keyup', key, { capture: true, signal: events.signal });
}
export function shellPaths(files: DraggedFile[]): string {
    return files.map(file => `'${file.path.replace(/'/g, `'\\''`)}'`).join(' ') + ' ';
}
export function animateFileDrop(files: DraggedFile[], event: { clientX: number; clientY: number }, target: HTMLElement) {
    if (!files.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const chip = el('div', 'file-drop-animation');
    chip.append(icon('File'), el('span', '', fileGroupLabel(files)));
    Object.assign(chip.style, { left: `${event.clientX}px`, top: `${event.clientY}px` });
    document.body.append(chip);
    const rect = target.getBoundingClientRect();
    const animation = chip.animate([{ transform: 'translate(-50%, -50%) scale(1)', opacity: 1 }, { transform: `translate(${rect.x + rect.width / 2 - event.clientX}px, ${Math.min(rect.y + 50, rect.bottom) - event.clientY}px) scale(.5)`, opacity: 0 }], { duration: 240, easing: 'ease-in', fill: 'forwards' });
    animation.finished.finally(() => chip.remove());
}
