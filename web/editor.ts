import { Compartment, EditorView, EditorState, lineNumbers, history, historyKeymap, defaultKeymap, keymap, bracketMatching, indentOnInput, HighlightStyle, syntaxHighlighting, StreamLanguage, tags, languages } from './vendor/code-editor/library.js';
import { xml } from './vendor/code-editor/xml.js';
import { api, button, confirmAction, el, notify, popover, scopeNotifications } from './ui';
import { fittingHeaderItemCount } from './overflow';
import { download } from './transfers';
import type { DraggedFile } from './file-drag';
import { languageFor, PageDraft, pageLimitError, pageWrapping, type TextPage } from './editor-page';
import { ImageViewer, isImage } from './image-viewer';
export { languageFor } from './editor-page';

const modes = ['css', 'go', 'html', 'javascript', 'json', 'jsx', 'markdown', 'python', 'shell', 'sql', 'text', 'toml', 'tsx', 'typescript', 'xml', 'yaml'];
const undoCommand = historyKeymap.find(binding => binding.key === 'Mod-z')!.run;
const redoCommand = historyKeymap.find(binding => binding.key === 'Mod-y')!.run;
function mediaKind(name: string) {
    if (isImage(name)) return 'image';
    const ext = name.split('.').pop()!.toLowerCase();
    if (ext === 'pdf') return 'pdf';
    if (['mp4','webm','ogv','mov'].includes(ext)) return 'video';
    if (['mp3','wav','ogg','m4a','flac'].includes(ext)) return 'audio';
}
async function languageMode(name: string) {
    if (['javascript','typescript','jsx','tsx'].includes(name)) return (await languages.javascript())[`${name}Language`];
    if (name === 'text') return [];
    if (name === 'xml') return StreamLanguage.define(xml);
    if (['go','shell','toml'].includes(name)) return StreamLanguage.define((await languages[name]())[name]);
    if (name === 'sql') return (await languages.sql()).sql();
    return (await languages[name]())[`${name}Language`];
}
const highlighting = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.keyword, class: 'code-keyword' }, { tag: [tags.string,tags.regexp], class: 'code-string' },
    { tag: [tags.number,tags.bool,tags.null], class: 'code-number' }, { tag: [tags.comment,tags.meta], class: 'code-comment' },
    { tag: [tags.typeName,tags.className,tags.tagName,tags.attributeName], class: 'code-type' },
    { tag: [tags.definition(tags.variableName),tags.function(tags.variableName),tags.standard(tags.variableName)], class: 'code-function' },
    { tag: tags.heading, class: 'code-heading' },
    { tag: [tags.list,tags.processingInstruction,tags.contentSeparator], class: 'code-markup' },
    { tag: tags.monospace, class: 'code-monospace' },
    { tag: [tags.link,tags.url], class: 'code-link' },
    { tag: tags.quote, class: 'code-quote' },
    { tag: tags.strong, class: 'code-strong' },
    { tag: tags.emphasis, class: 'code-emphasis' },
    { tag: tags.strikethrough, class: 'code-strikethrough' }
]));
export class FileInspector {
    private root = el('section', 'file-inspector');
    private toolbar = el('div', 'inspector-toolbar');
    private body = el('div', 'inspector-body');
    private back = button('Back to files', 'ArrowLeft', () => this.close());
    private separator = el('span', 'file-navigation-separator', '|');
    private more = button('File tools', 'Ellipsis', () => this.menu());
    private toolbarItems: HTMLElement[] = [];
    private overflow: HTMLElement[] = [];
    private closeMenu = () => {};
    private resize = new ResizeObserver(() => this.fitToolbar());
    private pagination = el('div', 'inspector-pagination');
    private syntax = el('select', 'syntax-select');
    private saveButton = button('Save file', 'Save', () => this.save());
    private previous = button('Previous file', 'ChevronLeft', () => this.step(-1));
    private next = button('Next file', 'ChevronRight', () => this.step(1));
    private filePosition = el('span', 'inspector-position');
    private undo = button('Undo', 'Undo2', () => this.history('Mod-z'));
    private redo = button('Redo', 'Redo2', () => this.history('Mod-y'));
    private pageUp = button('Page up', 'ArrowUp', () => this.turnPage(-1));
    private pageDown = button('Page down', 'ArrowDown', () => this.turnPage(1));
    private pageLabel = el('span', 'inspector-page');
    private editor?: InstanceType<typeof EditorView>;
    private imageViewer?: ImageViewer;
    private language = new Compartment();
    private readOnly = new Compartment();
    private draft?: PageDraft;
    private page?: TextPage;
    private positions = [{ offset: 0, line: 1 }];
    private pageIndex = 0;
    private version = '';
    private dirty = false;
    private saving = false;
    private loading = false;
    private media = false;
    private sequence = 0;
    private request?: AbortController;
    private events = new AbortController();
    private index: number;
    constructor(private host: HTMLElement, private files: DraggedFile[], path: string, private closed: (path: string) => Promise<void>, private changed: (path: string, dirty: boolean) => void) {
        if (mediaKind(path)) this.files = files.filter(file => mediaKind(file.name));
        this.index = this.files.findIndex(file => file.path === path);
        scopeNotifications(this.root, host);
        this.root.tabIndex = -1;
        this.syntax.setAttribute('aria-label', 'Syntax');
        for (const name of modes) { const option = el('option', '', name); option.value = name; this.syntax.append(option); }
        this.syntax.onchange = () => this.setLanguage().catch(error => notify(error, host));
        this.pageLabel.setAttribute('aria-live', 'polite');
        this.filePosition.setAttribute('aria-live', 'polite');
        this.separator.setAttribute('aria-hidden', 'true');
        this.more.setAttribute('aria-haspopup', 'dialog');
        this.pagination.append(this.pageUp, this.pageLabel, this.pageDown);
        this.root.append(this.toolbar, this.body); host.append(this.root);
        this.resize.observe(this.toolbar);
        this.root.onkeydown = event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); this.save().catch(error => notify(error, host)); }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close().catch(error => notify(error, host)); }
            else if (this.media && !['INPUT','SELECT','BUTTON'].includes((event.target as Element).tagName) && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); this.step(event.key === 'ArrowLeft' ? -1 : 1).catch(error => notify(error, host)); }
        };
        window.addEventListener('beforeunload', event => { if (this.dirty) event.preventDefault(); }, { signal: this.events.signal });
        this.load().catch(error => notify(error, host));
    }
    private get file() { return this.files[this.index]; }
    canClose = async () => !this.root.inert && !this.saving && (!this.dirty || await confirmAction('Discard changes?', this.file.name, 'Discard'));
    private controls() {
        this.changed(this.file.path, this.dirty);
        this.filePosition.textContent = `${this.index + 1}/${this.files.length}`;
        this.previous.disabled = this.next.disabled = this.files.length < 2;
        for (const control of [this.syntax, this.saveButton, this.undo, this.redo]) control.hidden = !this.editor;
        this.pagination.hidden = !this.editor || !this.page || (this.pageIndex === 0 && this.page.end >= this.page.total);
        const busy = this.saving || this.loading;
        // Query the bundled commands without applying their transactions.
        const state = this.editor && { state: this.editor.state, dispatch: () => {} };
        this.undo.disabled = busy || !state || !undoCommand(state);
        this.redo.disabled = busy || !state || !redoCommand(state);
        this.syntax.disabled = busy;
        this.saveButton.disabled = !this.dirty || busy;
        this.pageUp.disabled = busy || this.pageIndex === 0;
        this.pageDown.disabled = busy || !this.page || this.page.end >= this.page.total;
        this.pageLabel.textContent = `Page ${this.pageIndex + 1}`;
        this.body.setAttribute('aria-busy', String(busy));
        this.fitToolbar();
    }
    private fitToolbar() {
        if (!this.toolbar.getClientRects().length) return;
        this.closeMenu();
        this.toolbarItems.forEach(item => item.classList.remove('toolbar-hidden'));
        const items = this.toolbarItems.filter(item => !item.hidden);
        this.more.hidden = false;
        const style = getComputedStyle(this.toolbar), gap = parseFloat(style.columnGap) || 0;
        const available = this.toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
            - this.back.offsetWidth - this.separator.offsetWidth - gap * 2;
        const widths = items.map(item => {
            const style = getComputedStyle(item);
            return item.getBoundingClientRect().width + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
        });
        const count = fittingHeaderItemCount(widths, available, this.more.offsetWidth, gap);
        this.overflow = items.slice(count);
        for (const item of this.overflow) {
            if (item.contains(document.activeElement)) this.more.focus();
            item.classList.add('toolbar-hidden');
        }
        this.more.hidden = !this.overflow.length;
    }
    private menu() {
        const content = el('div', 'menu-actions inspector-menu');
        content.setAttribute('role', 'dialog'); content.setAttribute('aria-label', 'File tools');
        scopeNotifications(content, this.host);
        for (const item of this.overflow) {
            const controls = item.matches('button,select') ? [item] : [...item.children];
            for (const source of controls) {
                if (source instanceof HTMLButtonElement) {
                    const action = button(source.title, undefined, () => { this.closeMenu(); source.click(); });
                    action.replaceChildren(...[...source.childNodes].map(node => node.cloneNode(true)), el('span', '', source.title));
                    action.disabled = source.disabled; content.append(action);
                } else if (source instanceof HTMLSelectElement) {
                    const select = source.cloneNode(true) as HTMLSelectElement; select.value = source.value;
                    select.onchange = () => { source.value = select.value; this.closeMenu(); source.dispatchEvent(new Event('change')); };
                    const label = el('label', 'field', 'Syntax'); label.append(select); content.append(label);
                } else content.append(source.cloneNode(true));
            }
        }
        ({ close: this.closeMenu } = popover(this.more, content));
    }
    private history(key: string) {
        if (!this.editor || this.saving || this.loading) return;
        historyKeymap.find(binding => binding.key === key)?.run(this.editor);
        this.editor.focus();
    }
    private async setLanguage() {
        const editor = this.editor, name = this.syntax.value;
        const extension = await languageMode(name);
        if (this.editor === editor && this.syntax.value === name) editor?.dispatch({ effects: this.language.reconfigure(extension) });
    }
    private async load() {
        ++this.sequence;
        this.request?.abort();
        this.imageViewer?.dispose(); this.imageViewer = undefined;
        this.releaseMedia();
        this.editor?.destroy(); this.editor = undefined; this.dirty = false;
        this.page = undefined; this.draft = undefined; this.pageIndex = 0; this.positions = [{ offset: 0, line: 1 }]; this.version = ''; this.loading = false;
        this.body.replaceChildren();
        this.changed(this.file.path, false);
        const kind = mediaKind(this.file.name), url = `/api/preview/${encodeURIComponent(this.file.name)}?path=${encodeURIComponent(this.file.path)}`;
        this.media = kind !== undefined;
        if (kind === 'image') {
            this.imageViewer = new ImageViewer(this.body, url, this.file.name);
        } else if (kind === 'pdf') {
            const frame = el('iframe', 'file-pdf'); frame.title = this.file.name; frame.src = url; this.body.append(frame);
        } else if (kind === 'video' || kind === 'audio') {
            const media = el(kind, 'file-media');
            media.controls = true; media.preload = 'metadata'; media.src = url; media.onerror = () => notify('This browser cannot play the file', this.host); this.body.append(media);
        } else {
            this.body.append(el('div', 'empty', 'Loading…'));
            this.syntax.value = languageFor(this.file.path);
        }
        const downloadButton = button('Download file', 'Download', () => download(this.file.path, this.file.name, this.host));
        this.toolbar.classList.toggle('media-toolbar', this.media);
        if (this.media) {
            const navigation = el('div', 'inspector-navigation'), actions = el('div', 'inspector-actions');
            navigation.append(this.previous, this.filePosition, this.next);
            if (this.imageViewer?.copyButton) actions.append(this.imageViewer.copyButton);
            actions.append(downloadButton);
            this.toolbarItems = [navigation, ...(this.imageViewer ? [this.imageViewer.controls] : []), actions];
        } else {
            this.toolbarItems = [this.undo, this.redo, this.syntax, downloadButton, this.saveButton, this.pagination];
        }
        this.toolbar.replaceChildren(this.back, this.separator, ...this.toolbarItems, this.more);
        if (!this.media) await this.loadPage(0);
        this.controls();
        if (this.imageViewer) this.imageViewer.focus();
        else if (!this.editor) this.root.focus();
    }
    private async loadPage(index: number) {
        const generation = ++this.sequence, position = this.positions[index];
        this.request?.abort(); const request = this.request = new AbortController();
        this.loading = true; this.controls();
        this.editor?.dispatch({ effects: this.readOnly.reconfigure(EditorState.readOnly.of(true)) });
        try {
            const value = await api('/files', 'POST', { operation: 'read', path: this.file.path, offset: position.offset, version: this.version }, request.signal);
            if (generation !== this.sequence) return;
            const state = EditorState.create({ doc: value.content || '', extensions: [
                lineNumbers({ formatNumber: number => String(position.line + number - 1) }),
                history(), bracketMatching(), indentOnInput(), highlighting, pageWrapping,
                this.language.of([]), this.readOnly.of(EditorState.readOnly.of(false)),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                EditorView.contentAttributes.of({ 'aria-label': 'File content' }),
                EditorState.transactionFilter.of(transaction => {
                    if (!transaction.docChanged) return transaction;
                    if (this.saving || this.loading) return [];
                    const content = this.draft!.content(this.draft!.changes.compose(transaction.changes));
                    const error = pageLimitError(content);
                    if (error) { queueMicrotask(() => notify(error, this.host)); return []; }
                    return transaction;
                }),
                EditorView.updateListener.of(update => {
                    if (!update.docChanged) return;
                    this.draft!.changes = this.draft!.changes.compose(update.changes);
                    this.dirty = this.draft!.dirty(update.state.doc);
                    this.controls();
                })
            ] });
            this.editor?.destroy(); this.body.replaceChildren();
            this.draft = new PageDraft(value.content || '', state);
            this.pageIndex = index; this.page = value.page; this.version = value.version; this.dirty = false;
            this.editor = new EditorView({ parent: this.body, state });
            await this.setLanguage();
            if (generation === this.sequence) this.editor?.focus();
        } catch (error) {
            if (request.signal.aborted || generation !== this.sequence) return;
            if (this.editor) notify(error, this.host);
            else this.body.replaceChildren(el('div', 'empty', error instanceof Error ? error.message : 'Cannot open file'));
        } finally {
            if (generation === this.sequence) {
                this.loading = false;
                this.editor?.dispatch({ effects: this.readOnly.reconfigure(EditorState.readOnly.of(false)) });
                this.controls();
            }
        }
    }
    private async save() {
        if (!this.editor || !this.dirty || this.saving || this.loading) return;
        const content = this.draft!.content(), path = this.file.path, editor = this.editor;
        this.saving = true; this.controls();
        editor.dispatch({ effects: this.readOnly.reconfigure(EditorState.readOnly.of(true)) });
        try {
            const result = await api('/files', 'POST', { operation: 'write', path, content, version: this.version, page: this.page }, this.events.signal);
            if (this.events.signal.aborted) return;
            this.draft = new PageDraft(content, editor.state);
            this.version = result.version; this.page = result.page; this.dirty = false;
            this.positions.length = this.pageIndex + 1;
            notify('Saved', this.host);
        } finally {
            this.saving = false;
            if (!this.events.signal.aborted) {
                editor.dispatch({ effects: this.readOnly.reconfigure(EditorState.readOnly.of(false)) });
                this.controls();
            }
        }
    }
    private async turnPage(direction: number) {
        if (!this.page || this.loading || this.saving || (direction < 0 && !this.pageIndex) || (direction > 0 && this.page.end >= this.page.total)) return;
        if (this.dirty) {
            if (!await confirmAction('Save changes?', this.file.name, 'Save and continue')) return;
            if (this.events.signal.aborted) return;
            await this.save();
            if (this.dirty || this.events.signal.aborted) return;
        }
        const next = this.pageIndex + direction;
        if (direction > 0) this.positions[next] = { offset: this.page.end, line: this.positions[this.pageIndex].line + this.page.lineBreaks };
        await this.loadPage(next);
    }
    private async step(direction: number) { if (this.files.length < 2 || !await this.canClose()) return; this.index = (this.index + direction + this.files.length) % this.files.length; await this.load(); }
    async leave(action: () => Promise<void>) {
        if (!await this.canClose() || this.events.signal.aborted) return;
        this.root.inert = true;
        try { await action(); }
        finally { this.root.inert = false; }
    }
    close() { return this.leave(() => this.closed(this.file.path)); }
    private releaseMedia() { this.body.querySelectorAll<HTMLMediaElement>('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); }); }
    dispose() { this.sequence++; this.request?.abort(); this.events.abort(); this.resize.disconnect(); this.closeMenu(); this.editor?.destroy(); this.imageViewer?.dispose(); this.releaseMedia(); this.root.remove(); }
}
