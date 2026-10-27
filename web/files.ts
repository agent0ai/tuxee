import { api, ask, bindContextMenu, button, confirmAction, el, icon, modal, notify, popover, scopeNotifications } from './ui';
import { download, downloadArchive, upload, uploadBatch, type UploadSource, operation as trackOperation } from './transfers';
import { join, type Panel, type Hooks, type View } from './model';
import { FileInspector } from './editor';
import { fittingHeaderItemCount } from './overflow';
import { folderSize } from './file-size';
import { compactSize } from './monitor-values';
import { registerFileDrop, registerUploadInput, setDropFeedback, animateFileDrop, startFileDrag, type DraggedFile } from './file-drag';
import { copyFiles, readFileClipboard, pasteFiles, readDeviceClipboard, clearFileCut, isFileCut } from './file-clipboard';
type Entry = {
    name: string;
    path: string;
    directory: boolean;
    symlink: boolean;
    size: number;
    mode: string;
    uid: number;
    gid: number;
    modified: string;
    link?: string;
    originalPath?: string;
    deleted?: string;
};
const trashPath = 'trash:///';
const instances = new Set<FileView>();
const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export class FileView implements View {
    private entries: Entry[] = [];
    private selected = new Set<string>();
    private list = el('div', 'file-list');
    private pathInput = el('input', 'path-input');
    private nav = el('form', 'file-nav');
    private modified = el('span', 'file-modified', '•');
    private status = el('span', 'file-status');
    private disposed = false;
    private events = new AbortController();
    private request?: AbortController;
    private uploadedDirectories = new Set<string>();
    private focusedPath = '';
    private lastTap?: { path: string; time: number };
    private selectionAnchor = '';
    private filter = '';
    private filterInput = el('input', 'file-filter');
    private filterButton = button('Filter files', 'Search', () => this.showFilter(this.filterInput.hidden));
    private showHidden = el('input');
    private sort?: { column: 'name' | 'size' | 'modified'; descending: boolean };
    private cancelSelection?: () => void;
    private rowMenus: (() => void)[] = [];
    private closeMenu = () => {};
    private selectAll = el('input');
    private inspector?: FileInspector;
    private uploadInput = el('input');
    private pasteInput: (data: DataTransfer) => boolean;
    private actionButtons: HTMLButtonElement[] = [];
    private fitActions = () => {};
    private get inTrash() { return this.panel.path === trashPath; }
    constructor(private root: HTMLElement, private panel: Panel, private hooks: Hooks) {
        instances.add(this);
        window.addEventListener('tuxee-file-cut', event => {
            const path = (event as CustomEvent<string>).detail;
            for (const row of this.list.querySelectorAll<HTMLElement>(path ? `.file-entry[data-path="${CSS.escape(path)}"]` : '.file-entry')) this.paintCut(row);
        }, { signal: this.events.signal });
        window.addEventListener('tuxee-files-uploaded', event => {
            for (const path of (event as CustomEvent<Set<string>>).detail) this.uploadedDirectories.add(path);
            if (!this.request) this.refreshUploaded();
        }, { signal: this.events.signal });
        root.classList.add('file-view');
        this.pathInput.value = panel.path || hooks.defaultDirectory();
        this.pathInput.setAttribute('aria-label', 'File or directory path');
        this.pathInput.autocomplete = 'off'; this.pathInput.spellcheck = false;
        let editTimer: number | undefined;
        const cancelEdit = () => clearTimeout(editTimer);
        for (const event of ['pointerdown', 'keydown', 'focusin']) document.addEventListener(event, cancelEdit, { capture: true, signal: this.events.signal });
        for (const event of ['blur', 'resize']) window.addEventListener(event, cancelEdit, { signal: this.events.signal });
        this.events.signal.addEventListener('abort', cancelEdit, { once: true });
        this.pathInput.onpointerdown = event => {
            if (document.activeElement === this.pathInput) event.stopPropagation();
            else event.preventDefault(); // Keep header dragging and double-click expansion available before editing.
        };
        this.pathInput.onclick = event => {
            if (document.activeElement === this.pathInput) return;
            if (!this.nav.closest('.panel-header')) this.pathInput.focus();
            else if (event.detail === 1) editTimer = window.setTimeout(() => { if (this.pathInput.isConnected) this.pathInput.focus(); }, 300);
        };
        this.pathInput.ondblclick = event => {
            cancelEdit();
            if (document.activeElement === this.pathInput) event.stopPropagation();
            else event.preventDefault();
        };
        this.pathInput.onfocus = () => this.pathInput.select();
        this.pathInput.onblur = () => { this.pathInput.value = this.pathInput.title || this.panel.path; this.pathInput.scrollLeft = 0; };
        this.pathInput.onkeydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); this.pathInput.blur(); }
        };
        this.modified.hidden = true; this.modified.title = 'Unsaved changes'; this.modified.setAttribute('aria-label', 'Unsaved changes');
        this.nav.append(this.pathInput, this.modified);
        this.nav.onsubmit = event => {
            event.preventDefault();
            this.openPath(this.pathInput.value).catch(this.notice);
        };
        root.closest('.panel')!.querySelector('.panel-title')!.remove();
        const actions = el('div', 'file-actions');
        const actionButtons = this.actionButtons = [button('Parent directory', 'ArrowUp', () => this.parent(), 'file-navigation'), button('Home directory', 'House', () => this.navigate(hooks.defaultDirectory()), 'file-navigation'), button('Trash bin', 'Trash2', () => this.navigate(trashPath), 'file-navigation'), button('Restore', 'Undo2', () => this.restore()), button('Empty bin', 'Trash2', () => this.emptyTrash()), button('Refresh files', 'RefreshCw', () => this.refresh()), button('New folder', 'FolderPlus', () => this.mkdir()), button('New file', 'FilePlus', () => this.createFile()), button('Upload files', 'Upload', () => this.uploadInput.click()), button('Download selected', 'Download', () => this.downloadSelected()), button('Cut', 'Scissors', () => this.copySelection(true)), button('Copy', 'Copy', () => this.copySelection()), button('Paste', 'ClipboardPaste', () => this.paste()), button('Open terminal here', 'SquareTerminal', () => this.hooks.openTerminal(this.panel.path))];
        const separator = el('span', 'file-navigation-separator', '|'); separator.setAttribute('aria-hidden', 'true');
        const trashSeparator = separator.cloneNode(true) as HTMLElement;
        const trashItems = [actionButtons[3], actionButtons[4], trashSeparator];
        const actionItems = [...actionButtons.slice(0, 3), separator, ...trashItems, ...actionButtons.slice(5)];
        const more = button('File actions', 'Ellipsis', () => this.menu(more, !this.selected.size, actionButtons.filter(item => item.hidden && (this.inTrash || !trashItems.includes(item)))));
        more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
        actions.append(...actionItems, more);
        this.uploadInput.type = 'file';
        this.uploadInput.multiple = true;
        this.uploadInput.hidden = true;
        this.uploadInput.onchange = () => this.uploadFiles([...this.uploadInput.files || []]);
        const header = el('div', 'file-columns');
        const selectAll = el('label', 'file-select');
        this.selectAll.type = 'checkbox';
        this.selectAll.setAttribute('aria-label', 'Select all visible files');
        this.selectAll.onchange = () => {
            for (const entry of this.visibleEntries()) {
                if (this.selectAll.checked) this.selected.add(entry.path); else this.selected.delete(entry.path);
            }
            this.paintSelection();
        };
        selectAll.append(this.selectAll); header.append(selectAll);
        for (const [column, label] of [['name', 'Name'], ['size', 'Size'], ['modified', 'Modified']] as const) {
            const heading = button(`Sort by ${label}`, undefined, () => {
                this.sort = this.sort?.column !== column ? { column, descending: false } : !this.sort.descending ? { column, descending: true } : undefined;
                for (const item of header.querySelectorAll('button')) {
                    const active = item.dataset.column === this.sort?.column;
                    item.setAttribute('aria-pressed', String(active));
                    item.setAttribute('aria-description', active ? this.sort!.descending ? 'Descending' : 'Ascending' : 'Default order');
                    item.querySelector('.sort-indicator')!.textContent = active ? this.sort!.descending ? '▼' : '▲' : '';
                }
                this.render();
            });
            heading.dataset.column = column;
            heading.setAttribute('aria-pressed', 'false');
            const indicator = el('span', 'sort-indicator'); indicator.setAttribute('aria-hidden', 'true');
            heading.replaceChildren(el('span', '', label), indicator);
            header.append(heading);
        }
        this.list.setAttribute('role', 'listbox');
        this.list.setAttribute('aria-label', 'Files');
        this.list.setAttribute('aria-multiselectable', 'true');
        this.list.tabIndex = 0;
        this.list.onkeydown = e => { this.list.classList.add('keyboard-focus'); this.keydown(e); };
        // Drag handlers prevent default pointer focus, so track keyboard focus explicitly.
        this.list.addEventListener('pointerdown', () => this.list.classList.remove('keyboard-focus'), { capture: true, signal: this.events.signal });
        this.list.oncontextmenu = e => { e.preventDefault(); this.clearSelection(); this.menu({ x: e.clientX, y: e.clientY }, true); };
        this.list.onpointerdown = e => this.startSelection(e);
        this.list.onscroll = this.list.onpointercancel = () => { this.lastTap = undefined; };
        this.list.onclick = e => { if (!(e.target as Element).closest('.file-entry') && !e.ctrlKey && !e.metaKey && !e.shiftKey) this.clearSelection(); };
        const dropTarget = root.closest<HTMLElement>('.panel')!;
        for (const type of ['copy', 'cut'] as const) dropTarget.addEventListener(type, event => {
            if (this.disposed || this.inspector || this.inTrash || (event.target as Element).closest('input:not([type=checkbox]), textarea, [contenteditable]')) return;
            if (this.selected.size) {
                try { this.copySelection(type === 'cut', event); } catch (error) { this.notice(error); }
            }
        }, { signal: this.events.signal });
        registerFileDrop(dropTarget, {
            over: drop => { if (this.inTrash) return false; setDropFeedback(root, drop.copy ? 'Copy here' : 'Move here'); return drop.copy || drop.source !== panel.id; },
            leave: () => setDropFeedback(root),
            drop: drop => {
                if (this.inTrash) return;
                const entries = drop.files, operation = drop.copy ? 'copy' : 'move';
                const targetRow = drop.target.closest<HTMLElement>('.file-entry');
                const folder = this.entries.find(entry => entry.path === targetRow?.dataset.path && entry.directory && !entries.some(source => source.path === entry.path));
                animateFileDrop(entries, drop, this.list);
                this.transfer(entries, folder?.path || panel.path, operation).then(paths => {
                    for (const row of this.list.querySelectorAll<HTMLElement>('.file-entry'))
                        if (paths.includes(row.dataset.path!)) row.classList.add('file-arrived');
                }).catch(this.notice);
            }
        }, this.events.signal);
        this.pasteInput = registerUploadInput(dropTarget, {
            accept: () => !this.disposed && !this.inspector && !this.inTrash,
            over: () => setDropFeedback(root, 'Upload'),
            leave: () => setDropFeedback(root),
            upload: (sources, point) => { void this.uploadFiles(sources, point); },
            paste: data => {
                try {
                    const clipboard = readFileClipboard(data, this.hooks.user.uid);
                    if (!clipboard) return false;
                    const destination = this.panel.path;
                    void pasteFiles(clipboard, (files, operation, settled) => this.transfer(files, destination, operation, settled)).catch(this.notice);
                } catch (error) { this.notice(error); }
                return true;
            }
        }, this.events.signal);
        const footer = el('div', 'file-footer');
        this.filterInput.type = 'search'; this.filterInput.hidden = true;
        this.filterInput.placeholder = 'Filter'; this.filterInput.setAttribute('aria-label', 'Filter files');
        this.filterInput.autocomplete = 'off'; this.filterInput.spellcheck = false;
        this.filterButton.setAttribute('aria-expanded', 'false');
        this.filterInput.oninput = () => { this.filter = this.filterInput.value; this.render(); };
        this.filterInput.onkeydown = e => {
            if (e.isComposing) return;
            if (e.key === 'Escape') { e.preventDefault(); this.showFilter(false); }
            else if (['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); this.focus(this.focusedPath); }
        };
        const hiddenSeparator = el('span', 'file-footer-separator', '|'); hiddenSeparator.setAttribute('aria-hidden', 'true');
        const hiddenLabel = el('label', 'file-hidden');
        this.showHidden.type = 'checkbox';
        this.showHidden.onchange = () => this.render();
        hiddenLabel.append(this.showHidden, 'Hidden');
        footer.append(this.filterButton, this.filterInput, hiddenSeparator, hiddenLabel, this.status, button('Properties', 'Info', () => this.properties()));
        const table = el('div', 'file-table');
        table.append(header, this.list);
        root.append(actions, table, footer, this.uploadInput);
        this.resize();
        const fitActions = this.fitActions = () => {
            if (!actions.getClientRects().length) return;
            this.closeMenu();
            for (const item of trashItems) {
                if (!this.inTrash) item.remove();
                else if (item.parentElement !== actions) actions.insertBefore(item, actionButtons[5]);
            }
            const items = actionItems.filter(item => this.inTrash || !trashItems.includes(item));
            actionItems.forEach(item => { item.hidden = !items.includes(item); });
            const style = getComputedStyle(actions), gap = parseFloat(style.columnGap) || 0;
            const available = actions.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            // Count the permanent menu button too, so it always retains its space.
            const count = fittingHeaderItemCount([...items, more].map(item => item.getBoundingClientRect().width), available, more.getBoundingClientRect().width, gap);
            items.forEach((item, index) => { item.hidden = index >= count; });
            if (actionButtons.some(item => item.hidden && item === document.activeElement)) more.focus();
        };
        const observer = new ResizeObserver(fitActions); observer.observe(actions); fitActions();
        this.events.signal.addEventListener('abort', () => { observer.disconnect(); this.closeMenu(); }, { once: true });
        this.paintSelection();
        this.navigate(this.pathInput.value).catch(this.notice);
    }
    private notice = (value: unknown) => notify(value, this.root);
    private showPath = (path: string, dirty = false) => {
        if (this.pathInput.title === path && this.modified.hidden === !dirty) return;
        this.pathInput.title = path;
        if (document.activeElement !== this.pathInput) this.pathInput.value = path;
        this.modified.hidden = !dirty;
        this.hooks.title?.((path === trashPath ? 'Trash bin' : path.split('/').filter(Boolean).at(-1) || 'Files') + (dirty ? ' •' : ''));
    };
    private async openPath(path: string) {
        if (path === trashPath) {
            if (this.inspector) await this.inspector.leave(async () => { if (await this.navigate(path)) { this.inspector?.dispose(); this.inspector = undefined; this.showPath(path); } });
            else await this.navigate(path);
            return;
        }
        this.request?.abort();
        const request = this.request = new AbortController();
        try {
            const { entry } = await api('/files', 'POST', { operation: 'stat', path }, request.signal);
            if (request.signal.aborted || this.disposed) return;
            if (entry.directory) {
                const navigate = async () => {
                    if (request.signal.aborted || this.disposed) return;
                    this.request = undefined;
                    if (!await this.navigate(entry.path)) return;
                    this.inspector?.dispose(); this.inspector = undefined;
                    this.showPath(this.panel.path);
                };
                if (this.inspector) await this.inspector.leave(navigate);
                else await navigate();
            } else await this.openFile(entry, request.signal);
            if (this.pathInput.value === path || this.pathInput.value === this.pathInput.title) this.pathInput.blur();
        } catch (error) {
            if (!request.signal.aborted) throw error;
        } finally {
            if (this.request === request) this.request = undefined;
        }
    }
    resize() {
        const compact = !!this.root.closest('.compact-board');
        const parent = compact ? this.root : this.root.closest('.panel')!.querySelector('.panel-header')!;
        if (this.nav.parentElement !== parent) {
            if (compact) parent.prepend(this.nav);
            else parent.insertBefore(this.nav, parent.querySelector('.panel-tools'));
        }
    }
    private async navigate(path: string, focusPath?: string) {
        this.cancelSelection?.();
        const focusOwner = document.activeElement;
        const restoreFocus = focusPath !== undefined || this.list.contains(focusOwner);
        const previousPath = this.panel.path, focused = focusPath ?? this.focusedPath;
        this.request?.abort();
        const request = this.request = new AbortController(), previousInput = this.pathInput.value;
        this.status.textContent = 'Loading…';
        this.list.classList.add('loading');
        try {
            const response = await api('/files', 'POST', { operation: path === trashPath ? 'trash-list' : 'list', path }, request.signal);
            if (this.disposed || request.signal.aborted)
                return;
            this.panel.path = response.path;
            if (!this.inspector) this.showPath(response.path);
            if (!this.inspector && this.pathInput.value === previousInput)
                this.pathInput.value = response.path;
            this.entries = response.entries || [];
            if (previousPath !== response.path) { this.selected.clear(); this.filter = this.filterInput.value = ''; this.selectionAnchor = ''; }
            else this.selected = new Set(this.entries.filter(entry => this.selected.has(entry.path)).map(entry => entry.path));
            const focusStillHere = document.activeElement === focusOwner || this.list.contains(document.activeElement);
            this.render();
            this.fitActions();
            if (restoreFocus && focusStillHere) this.focus(focused);
            this.hooks.changed();
            if (response.truncated)
                this.status.textContent += ' · First 10,000 entries';
            return true;
        }
        catch (error) {
            if (!request.signal.aborted) {
                this.status.textContent = error instanceof Error ? error.message : 'Cannot read directory';
                throw error;
            }
        }
        finally {
            if (!request.signal.aborted) {
                this.request = undefined;
                this.list.classList.remove('loading');
                this.refreshUploaded();
            }
        }
    }
    private refreshUploaded() {
        const affected = this.uploadedDirectories.has(this.panel.path);
        this.uploadedDirectories.clear();
        if (affected && !this.disposed) this.refresh().catch(this.notice);
    }
    refresh = () => this.navigate(this.panel.path);
    private parent() { return this.navigate(this.inTrash ? this.hooks.defaultDirectory() : this.panel.path.split('/').slice(0, -1).join('/') || '/', this.panel.path); }
    private visibleEntries() {
        const query = this.filter.toLocaleLowerCase(), entries = this.entries.filter(entry =>
            (this.inTrash || this.showHidden.checked || !entry.name.startsWith('.')) && entry.name.toLocaleLowerCase().includes(query));
        if (this.sort) {
            const { column, descending } = this.sort;
            entries.sort((a, b) => ((column === 'size' ? a.size - b.size : column === 'modified' ? Date.parse(a.modified) - Date.parse(b.modified) : nameOrder.compare(a.name, b.name)) || a.name.localeCompare(b.name)) * (descending ? -1 : 1));
        }
        return entries;
    }
    private showFilter(open = true) {
        this.filterInput.hidden = !open;
        this.filterButton.setAttribute('aria-expanded', String(open));
        if (open) { this.filterInput.focus(); this.filterInput.setSelectionRange(this.filterInput.value.length, this.filterInput.value.length); }
        else { this.filter = this.filterInput.value = ''; this.render(); this.focus(this.focusedPath); }
    }
    private render() {
        this.lastTap = undefined;
        this.cancelSelection?.();
        this.rowMenus.splice(0).forEach(dispose => dispose());
        const entries = this.visibleEntries();
        this.list.replaceChildren();
        if (!entries.length) this.list.append(el('div', 'empty', this.filter ? 'No matches' : 'Empty folder'));
        for (const entry of entries) {
            const row = el('div', 'file-entry');
            row.dataset.path = entry.path;
            row.dataset.directory = String(entry.directory);
            if (entry.originalPath) row.title = `${entry.originalPath}${entry.deleted ? `\nDeleted: ${entry.deleted.replace('T', ' ')}` : ''}`;
            row.tabIndex = -1;
            row.addEventListener('focusin', () => { this.focusedPath = entry.path; });
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', 'false');
            const select = el('label', 'file-select'), checkbox = el('input');
            checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `Select ${entry.name}`);
            checkbox.onchange = () => {
                if (checkbox.checked) this.selected.add(entry.path); else this.selected.delete(entry.path);
                this.selectionAnchor = entry.path; this.paintSelection();
            };
            checkbox.onkeydown = event => { if (event.key === ' ') event.stopPropagation(); };
            select.onclick = select.ondblclick = event => event.stopPropagation();
            select.onpointerdown = event => { this.lastTap = undefined; event.stopPropagation(); this.startCheckSelection(event, entry.path); };
            select.append(checkbox);
            const name = el('span', 'file-name');
            name.append(icon(entry.directory ? 'Folder' : entry.symlink ? 'Link' : 'File'), el('span', '', entry.name));
            const bytes = el('span', 'file-size', entry.directory ? '—' : compactSize(entry.size, 1024));
            if (!entry.directory) bytes.title = `${entry.size.toLocaleString()} B`;
            row.append(select, name, bytes, el('span', 'file-date', new Date(entry.modified).toLocaleDateString()));
            row.onclick = e => {
                row.focus({ preventScroll: true });
                if (e.shiftKey && this.selectionAnchor) this.selectRange(entry.path);
                else if (e.ctrlKey || e.metaKey) {
                    if (this.selected.has(entry.path))
                        this.selected.delete(entry.path);
                    else
                        this.selected.add(entry.path);
                }
                else {
                    this.selected.clear();
                    this.selected.add(entry.path);
                }
                if (!e.shiftKey) this.selectionAnchor = entry.path;
                this.paintSelection();
                // Touch taps can hit different children of the same row, so native dblclick is insufficient.
                const touch = (e as PointerEvent).pointerType === 'touch';
                const twice = touch ? this.lastTap?.path === entry.path && e.timeStamp - this.lastTap.time < 400 : e.detail === 2;
                this.lastTap = touch && !twice ? { path: entry.path, time: e.timeStamp } : undefined;
                if (twice && !this.inTrash) (entry.directory ? this.navigate(entry.path) : this.openFile(entry)).catch(this.notice);
            };
            this.rowMenus.push(bindContextMenu(row, position => { if (!this.selected.has(entry.path)) {
                this.selected.clear();
                this.selected.add(entry.path);
                this.paintSelection();
            } row.focus({ preventScroll: true }); this.menu(position || row); }, true));
            row.onpointerdown = e => {
                if (this.inTrash) return;
                if (!this.selected.has(entry.path) && !(e.target as Element).closest('.file-name')) return;
                startFileDrag(e, this.panel.id, () => {
                    row.focus({ preventScroll: true });
                    if (!this.selected.has(entry.path)) { this.selected.clear(); this.selected.add(entry.path); this.paintSelection(); }
                    return this.chosen();
                }, this.events.signal);
            };
            this.list.append(row);
        }
        this.paintSelection();
    }
    private focus(path: string) {
        const rows = [...this.list.querySelectorAll<HTMLElement>('.file-entry')];
        const row = rows.find(row => row.dataset.path === path) || rows[0];
        (row || this.list).focus({ preventScroll: true });
        row?.scrollIntoView({ block: 'nearest' });
    }
    private keydown(e: KeyboardEvent) {
        const entries = this.visibleEntries(), index = entries.findIndex(entry => entry.path === this.focusedPath);
        const entry = entries[index];
        const run = (action: () => unknown) => { e.preventDefault(); Promise.resolve().then(action).catch(this.notice); };
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') run(() => { entries.forEach(entry => this.selected.add(entry.path)); this.paintSelection(); });
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') run(() => {
            const next = entries[Math.max(0, Math.min(entries.length - 1, index + (e.key === 'ArrowUp' ? -1 : 1)))];
            if (e.shiftKey && next) { if (!this.selectionAnchor) this.selectionAnchor = entry?.path || next.path; this.selectRange(next.path); }
            else this.selectionAnchor = next?.path || '';
            this.focus(next?.path || '');
        });
        else if (e.key === 'ArrowLeft') run(() => this.parent());
        else if (e.key === 'ArrowRight' || e.key === 'Enter') run(() => !this.inTrash ? entry?.directory ? this.navigate(entry.path, '') : e.key === 'Enter' && entry ? this.openFile(entry) : undefined : undefined);
        else if (e.key === ' ' && entry) run(() => { if (this.selected.has(entry.path)) this.selected.delete(entry.path); else this.selected.add(entry.path); this.selectionAnchor = entry.path; this.paintSelection(); });
        else if (e.key === 'Delete') run(() => this.remove(e.shiftKey));
        else if (e.key === 'F2' && !this.inTrash) run(() => this.rename());
        else if (e.key === 'F5') run(() => this.refresh());
        else if (e.key === 'Escape' && !this.filter) run(clearFileCut);
        else if (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10' || e.key === 'Alt' && !e.ctrlKey) run(() => {
            if (!this.selected.size && entry) { this.selected.add(entry.path); this.paintSelection(); }
            this.menu(this.list.contains(document.activeElement) ? document.activeElement as HTMLElement : this.list);
        });
        else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Escape' && this.filter)) run(() => {
            if (e.key === 'Escape') return this.showFilter(false);
            this.filter = this.filterInput.value = e.key === 'Backspace' ? this.filter.slice(0, -1) : this.filter + e.key;
            this.render(); this.showFilter();
        });
    }
    private selectRange(path: string) {
        const entries = this.visibleEntries(), start = Math.max(0, entries.findIndex(entry => entry.path === this.selectionAnchor)), end = entries.findIndex(entry => entry.path === path);
        if (end < 0) return;
        this.selected = new Set(entries.slice(Math.min(start, end), Math.max(start, end) + 1).map(entry => entry.path)); this.paintSelection();
    }
    private clearSelection() { this.selected.clear(); this.selectionAnchor = ''; this.paintSelection(); }
    private startCheckSelection(event: PointerEvent, path: string) {
        if (!event.isPrimary || event.button !== 0) return;
        this.cancelSelection?.();
        const target = event.currentTarget as HTMLElement, events = new AbortController(), signal = events.signal;
        const previous = new Set(this.selected), anchor = this.selectionAnchor, select = !previous.has(path);
        const bounds = this.list.getBoundingClientRect();
        const rows = [...this.list.querySelectorAll<HTMLElement>('.file-entry')].map(row => {
            const rect = row.getBoundingClientRect();
            return { path: row.dataset.path!, top: rect.top - bounds.top + this.list.scrollTop, bottom: rect.bottom - bounds.top + this.list.scrollTop };
        });
        const start = rows.findIndex(row => row.path === path);
        let dragging = false, y = event.clientY, frame = 0, lastTime = performance.now();
        target.setPointerCapture(event.pointerId);
        const update = () => {
            const index = rows.findIndex(row => y - bounds.top + this.list.scrollTop < row.bottom);
            const end = index < 0 ? rows.length - 1 : index;
            for (const row of rows.slice(Math.min(start, end), Math.max(start, end) + 1)) {
                if (select) this.selected.add(row.path); else this.selected.delete(row.path);
            }
            this.selectionAnchor = path; this.paintSelection();
        };
        const scroll = (time: number) => {
            const speed = y < bounds.top + 24 ? -Math.min(1, (bounds.top + 24 - y) / 24) : y > bounds.bottom - 24 ? Math.min(1, (y - bounds.bottom + 24) / 24) : 0;
            this.list.scrollTop += speed * Math.min(50, time - lastTime) * .7;
            lastTime = time; update(); frame = requestAnimationFrame(scroll);
        };
        const finish = (cancel = false) => {
            events.abort(); cancelAnimationFrame(frame); this.cancelSelection = undefined;
            if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
            if (cancel) { this.selected = previous; this.selectionAnchor = anchor; this.paintSelection(); }
            if (dragging || cancel) {
                // Escape can precede release indefinitely; a new pointer gesture ends suppression.
                const release = new AbortController(), signal = release.signal;
                document.addEventListener('click', click => {
                    if (!click.detail) return;
                    click.preventDefault(); click.stopImmediatePropagation(); release.abort();
                }, { capture: true, signal });
                window.addEventListener('pointerdown', () => release.abort(), { capture: true, once: true, signal });
            }
        };
        const cancel = this.cancelSelection = () => finish(true);
        target.addEventListener('pointermove', move => {
            if (move.pointerId !== event.pointerId) return;
            y = move.clientY;
            if (!dragging && Math.abs(y - event.clientY) >= 5) { dragging = true; frame = requestAnimationFrame(scroll); }
            if (dragging) update();
        }, { signal });
        target.addEventListener('pointerup', () => finish(), { signal });
        target.addEventListener('pointercancel', cancel, { signal });
        target.addEventListener('lostpointercapture', cancel, { signal });
        window.addEventListener('blur', cancel, { signal });
        window.addEventListener('resize', cancel, { signal });
        document.addEventListener('keydown', key => { if (key.key === 'Escape') { key.preventDefault(); key.stopImmediatePropagation(); cancel(); } }, { capture: true, signal });
    }
    private startSelection(event: PointerEvent) {
        if (event.defaultPrevented || event.button !== 0 || event.pointerType === 'touch') return;
        event.preventDefault();
        this.cancelSelection?.();
        const list = this.list, bounds = list.getBoundingClientRect(), events = new AbortController();
        const capture = (event.target as Element).closest('.file-entry') || list;
        const previous = new Set(this.selected), anchor = this.selectionAnchor, focused = this.focusedPath;
        const additive = event.ctrlKey || event.metaKey || event.shiftKey, box = el('div', 'file-selection-box');
        const startX = event.clientX - bounds.left, startY = event.clientY - bounds.top + list.scrollTop;
        // Cache content coordinates once; scrolling must not move the selection's origin.
        const rows = [...list.querySelectorAll<HTMLElement>('.file-entry')].map(row => {
            const rect = row.getBoundingClientRect();
            return { path: row.dataset.path!, left: rect.left - bounds.left, right: rect.right - bounds.left, top: rect.top - bounds.top + list.scrollTop, bottom: rect.bottom - bounds.top + list.scrollTop };
        });
        let x = event.clientX, y = event.clientY, dragging = false, frame = 0, lastTime = performance.now();
        list.focus({ preventScroll: true }); capture.setPointerCapture(event.pointerId);
        const update = () => {
            if (!dragging) return;
            const endX = Math.max(0, Math.min(list.clientWidth, x - bounds.left));
            const endY = Math.max(0, Math.min(list.scrollHeight, y - bounds.top + list.scrollTop));
            const left = Math.min(startX, endX), right = Math.max(startX, endX), top = Math.min(startY, endY), bottom = Math.max(startY, endY);
            Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
            this.selected = new Set(additive ? previous : []);
            const hits = rows.filter(row => row.left < right && row.right > left && row.top < bottom && row.bottom > top);
            for (const row of hits) this.selected.add(row.path);
            this.selectionAnchor = hits[0]?.path || anchor;
            this.focusedPath = hits.at(-1)?.path || focused;
            this.paintSelection();
        };
        const scroll = (time: number) => {
            const speed = y < bounds.top + 24 ? -Math.min(1, (bounds.top + 24 - y) / 24) : y > bounds.bottom - 24 ? Math.min(1, (y - bounds.bottom + 24) / 24) : 0;
            list.scrollTop += speed * Math.min(50, time - lastTime) * .7;
            lastTime = time;
            frame = requestAnimationFrame(scroll);
        };
        const finish = (cancel = false) => {
            events.abort(); cancelAnimationFrame(frame); box.remove(); this.cancelSelection = undefined;
            if (capture.hasPointerCapture(event.pointerId)) capture.releasePointerCapture(event.pointerId);
            if (cancel) { this.selected = previous; this.selectionAnchor = anchor; this.focusedPath = focused; this.paintSelection(); }
            if (dragging) {
                const suppress = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
                document.addEventListener('click', suppress, { capture: true, once: true });
                setTimeout(() => document.removeEventListener('click', suppress, true), 0);
            }
        };
        const cancel = this.cancelSelection = () => finish(true);
        list.addEventListener('pointermove', move => {
            x = move.clientX; y = move.clientY;
            if (!dragging && Math.hypot(x - event.clientX, y - event.clientY) >= 5) {
                dragging = true; list.append(box); frame = requestAnimationFrame(scroll);
            }
            update();
        }, { signal: events.signal });
        list.addEventListener('scroll', update, { signal: events.signal });
        list.addEventListener('pointerup', () => finish(), { signal: events.signal });
        list.addEventListener('pointercancel', cancel, { signal: events.signal });
        list.addEventListener('lostpointercapture', cancel, { signal: events.signal });
        window.addEventListener('blur', cancel, { signal: events.signal });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
        }, { capture: true, signal: events.signal });
    }
    private chosen() { return this.entries.filter(entry => this.selected.has(entry.path)); }
    private paintCut(row: HTMLElement) {
        const cut = isFileCut(row.dataset.path!, this.hooks.user.uid);
        row.classList.toggle('file-cut', cut);
        if (cut) row.setAttribute('aria-description', 'Cut'); else row.removeAttribute('aria-description');
    }
    private paintSelection() {
        const rows = this.list.querySelectorAll<HTMLElement>('.file-entry');
        let selected = 0;
        for (const row of rows) {
            const checked = this.selected.has(row.dataset.path!);
            row.setAttribute('aria-selected', String(checked));
            this.paintCut(row);
            row.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = checked;
            if (checked) selected++;
        }
        this.selectAll.checked = rows.length > 0 && selected === rows.length;
        this.selectAll.indeterminate = selected > 0 && selected < rows.length;
        this.selectAll.disabled = !rows.length;
        this.showHidden.disabled = this.inTrash;
        const properties = this.root.querySelector<HTMLButtonElement>('.file-footer button[title="Properties"]');
        if (properties) properties.disabled = this.inTrash && !this.selected.size;
        for (const action of this.actionButtons) {
            action.disabled = ['Download selected', 'Cut', 'Copy'].includes(action.title) ? !this.selected.size || this.inTrash
                : action.title === 'Restore' ? !this.selected.size
                : action.title === 'Empty bin' ? !this.entries.length
                : this.inTrash && ['New folder', 'New file', 'Upload files', 'Paste', 'Open terminal here'].includes(action.title);
        }
        this.status.textContent = `${this.filter || rows.length !== this.entries.length ? `${rows.length}/${this.entries.length}` : this.entries.length} items${this.selected.size ? ` · ${this.selected.size} selected` : ''}`;
    }
    private single() { const values = this.chosen(); if (values.length !== 1)
        throw new Error('Select one item first'); return values[0]; }
    private async mkdir() { const name = await ask('New folder', 'Folder name'); if (!name)
        return; this.checkName(name); await api('/files', 'POST', { operation: 'mkdir', path: join(this.panel.path, name) }); await this.refresh(); }
    private async createFile() { const name = await ask('New file', 'File name'); if (!name)
        return; this.checkName(name); await upload(join(this.panel.path, name), new File([], name), this.events.signal); await this.refresh(); }
    private checkName(name: string) { if (name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
        throw new Error('Use a filename without slashes'); }
    private async rename() { const entry = this.single(), name = await ask('Rename', 'New name', entry.name); if (!name || name === entry.name)
        return; this.checkName(name); await api('/files', 'POST', { operation: 'rename', path: entry.path, destination: join(this.panel.path, name) }); await this.refresh(); }
    private async remove(permanent = false) {
        const entries = this.chosen(), inTrash = this.inTrash;
        if (!entries.length)
            throw new Error('Select files to delete');
        const folders = entries.filter(entry => entry.directory && !entry.symlink).length, files = entries.length - folders;
        const summary = [files ? `${files} file${files === 1 ? '' : 's'}` : '', folders ? `${folders} folder${folders === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
        const choice = await new Promise<boolean | undefined>(resolve => {
            const content = el('div', 'form'), checkbox = el('input'), label = el('label', 'file-delete-permanent');
            checkbox.type = 'checkbox'; checkbox.checked = permanent || inTrash; checkbox.disabled = inTrash;
            label.append(checkbox, 'Delete permanently instead');
            const message = el('p', 'muted'), actions = el('div', 'actions');
            const submit = button('', undefined, () => { resolve(checkbox.checked); dialog.close(); }, 'primary');
            const update = () => {
                message.textContent = checkbox.checked ? `Permanently delete ${summary}?` : `Move ${summary} to trash bin?`;
                submit.textContent = submit.title = checkbox.checked ? 'Delete permanently' : 'Move to bin';
                submit.setAttribute('aria-label', submit.title);
            };
            checkbox.onchange = update; update();
            content.append(message);
            if (!inTrash) content.append(label);
            const { dialog } = modal('Delete selected items?', content);
            actions.append(button('Cancel', undefined, () => dialog.close()), submit); content.append(actions); submit.focus();
            dialog.addEventListener('close', () => resolve(undefined), { once: true });
        });
        if (choice === undefined) return;
        const operation = inTrash ? 'trash-delete' : choice ? 'delete' : 'trash';
        try {
            for (const entry of entries)
                await api('/files', 'POST', { operation, path: entry.path }, this.events.signal);
        }
        finally {
            this.refreshTrash(entries);
        }
    }
    private refreshTrash(entries: Entry[]) {
        const directories = new Set([trashPath, ...entries.flatMap(entry => [entry.path, entry.originalPath].filter(Boolean).map(path => path!.split('/').slice(0, -1).join('/') || '/'))]);
        window.dispatchEvent(new CustomEvent('tuxee-files-uploaded', { detail: directories }));
    }
    private async restore() {
        const entries = this.chosen();
        if (!entries.length) return;
        try { for (const entry of entries) await api('/files', 'POST', { operation: 'trash-restore', path: entry.path }, this.events.signal); }
        finally { this.refreshTrash(entries); }
    }
    private async emptyTrash() {
        const entries = this.entries;
        if (!await confirmAction('Empty trash bin?', 'Permanently delete everything in the trash bin?', 'Empty bin')) return;
        try { await api('/files', 'POST', { operation: 'trash-empty' }, this.events.signal); }
        finally { this.refreshTrash(entries); }
    }
    private async downloadSelected() {
        const entries = this.chosen();
        if (!entries.length) throw new Error('Select files or folders to download');
        if (entries.length > 1 || entries[0].directory) return downloadArchive(this.panel.path, entries.map(entry => entry.path), this.root);
        await download(entries[0].path, entries[0].name, this.root);
    }
    private async transferPrompt(operation: 'copy' | 'move') { const entries = this.chosen(); if (!entries.length)
        throw new Error('Select files first'); const path = await ask(`${operation === 'copy' ? 'Copy' : 'Move'} selected items`, 'Destination directory (absolute path)', this.panel.path); if (path)
        await this.transfer(entries, path, operation); }
    private copySelection(cut = false, event?: ClipboardEvent) { copyFiles(this.chosen(), this.hooks.user.uid, cut, event); }
    private async paste() {
        this.list.focus({ preventScroll: true });
        const path = this.panel.path, data = await readDeviceClipboard();
        if (this.disposed || this.inspector || path !== this.panel.path) return;
        if (!this.pasteInput(data)) this.notice('No Tuxee files on the clipboard');
    }
    private async transfer(entries: DraggedFile[], path: string, operation: 'copy' | 'move', settled?: (path: string, error?: unknown) => void) {
        if (!path.startsWith('/')) throw new Error('Use an absolute destination path');
        entries = entries.filter(entry => operation !== 'move' || entry.path !== join(path, entry.name));
        if (!entries.length) return [];
        const paths: string[] = [];
        try {
            await trackOperation(operation === 'copy' ? 'Copy' : 'Move', entries.length, async (signal, progress) => {
                for (const [index, entry] of entries.entries()) {
                    signal.throwIfAborted();
                    let result: { path: string };
                    try { result = await api('/files', 'POST', { operation, path: entry.path, destination: join(path, entry.name) }, signal); }
                    catch (error) { settled?.(entry.path, error); throw error; }
                    settled?.(entry.path);
                    paths.push(result.path);
                    progress(index + 1);
                }
            }, this.root);
            return paths;
        } finally {
            await Promise.all([...instances].map(view => view.refresh().catch(() => {})));
        }
    }
    private async openFile(entry = this.single(), signal?: AbortSignal) {
        if (!signal) this.request?.abort();
        if (entry.directory) return this.navigate(entry.path, '');
        if (this.inspector && !await this.inspector.canClose()) return;
        if (this.disposed || signal?.aborted) return;
        if (/\.(zip|7z|tar|tgz|tbz2|txz|tar\.(gz|bz2|xz))$/i.test(entry.name)) return this.archiveDialog(true, entry);
        this.request?.abort(); this.request = undefined;
        const parent = entry.path.split('/').slice(0, -1).join('/') || '/';
        const files = parent === this.panel.path ? this.visibleEntries().filter(file => !file.directory) : [];
        if (!files.some(file => file.path === entry.path)) files.push(entry);
        if (parent !== this.panel.path) {
            this.panel.path = parent; this.entries = []; this.selected.clear(); this.filter = this.filterInput.value = '';
            this.hooks.changed();
        }
        this.inspector?.dispose();
        this.inspector = new FileInspector(this.root, files, entry.path, async path => {
            if (!await this.navigate(path.split('/').slice(0, -1).join('/') || '/')) return;
            const restoreFocus = document.activeElement === document.body || this.root.contains(document.activeElement);
            this.inspector?.dispose(); this.inspector = undefined; this.showPath(this.panel.path);
            if (restoreFocus) this.focus(path);
        }, this.showPath);
    }
    canClose = () => this.inspector?.canClose() ?? Promise.resolve(true);
    private async archiveDialog(extract = false, entry?: Entry) {
        const entries = extract ? [entry || this.single()] : this.chosen();
        if (!entries.length) throw new Error('Select files first');
        const capabilities = await api('/files', 'POST', { operation: 'archive-formats', path: this.panel.path });
        const content = el('form', 'form'), filename = el('input'), format = el('select'), password = el('input');
        scopeNotifications(content, this.root);
        const base = entries.length === 1 ? entries[0].name.replace(/\.(tar\.(gz|bz2|xz)|tgz|tbz2|txz|zip|7z|tar)$/i, '') : 'Archive';
        filename.required = true; filename.setAttribute('aria-label', extract ? 'Extract folder' : 'Archive name');
        password.type = 'password'; password.autocomplete = 'off'; password.setAttribute('aria-label', 'Archive password');
        const field = (title: string, input: HTMLElement) => { const label = el('label', 'field', title); label.append(input); content.append(label); return label; };
        field(extract ? 'Folder' : 'Name', filename);
        if (!extract) {
            format.setAttribute('aria-label', 'Archive format');
            for (const value of capabilities.formats || []) { const option = el('option', '', value.name); option.value = value.name; format.append(option); }
            if (!format.options.length) throw new Error('Install tar or 7zip to create archives');
            format.value = [...format.options].some(option => option.value === 'tar.gz') ? 'tar.gz' : format.options[0].value;
            field('Format', format);
        }
        const passwordField = field('Password', password);
        const update = () => { filename.value = extract ? base : `${base}.${format.value}`; passwordField.hidden = !extract && !capabilities.formats.find(value => value.name === format.value)?.password; if (passwordField.hidden) password.value = ''; };
        format.onchange = update; update();
        const actions = el('div', 'actions'), submit = button(extract ? 'Extract' : 'Compress'); submit.type = 'submit'; submit.className = 'primary';
        actions.append(button('Cancel', undefined, () => close()), submit); content.append(actions);
        const { close } = modal(extract ? 'Extract archive' : 'Create archive', content);
        content.onsubmit = async event => {
            event.preventDefault(); if (!content.reportValidity()) return;
            try {
                this.checkName(filename.value); const secret = password.value; password.value = ''; submit.disabled = true;
                const request = { operation: extract ? 'extract' : 'compress', path: extract ? entries[0].path : this.panel.path, paths: extract ? undefined : entries.map(entry => entry.path), destination: join(this.panel.path, filename.value), format: extract ? undefined : format.value, password: secret };
                close();
                await trackOperation(extract ? 'Extract' : 'Compress', 1, async (signal, progress) => { await api('/files', 'POST', request, signal); progress(1); }, this.root);
                await this.refresh();
            } catch (error) { this.notice(error); submit.disabled = false; }
        };
        filename.focus(); filename.select();
    }
    private async properties() {
        const paths = this.chosen().map(entry => entry.path);
        if (!paths.length) paths.push(this.panel.path);
        const entries = [];
        for (const path of paths) entries.push((await api('/files', 'POST', { operation: 'stat', path })).entry);
        if (this.disposed) return;
        const common = (get: (entry: any) => unknown) => entries.every(entry => get(entry) === get(entries[0])) ? String(get(entries[0])) : 'Multiple';
        const content = el('div', 'form'), details = el('dl', 'properties');
        const lifetime = new AbortController();
        scopeNotifications(content, this.root);
        const values = {
            Name: entries.length === 1 ? entries[0].name : `${entries.length} items`, Path: common(entry => entry.path),
            Type: common(entry => entry.symlink ? 'Symbolic link' : entry.directory ? 'Directory' : 'File'),
            'Total size': compactSize(entries.reduce((sum, entry) => sum + (entry.directory && !entry.symlink ? 0 : entry.size), 0), 1024, true),
            'Owner UID': common(entry => entry.uid), 'Group GID': common(entry => entry.gid),
            Modified: common(entry => new Date(entry.modified).toLocaleString()), Accessed: common(entry => new Date(entry.accessed).toLocaleString()),
            'Metadata changed': common(entry => new Date(entry.changed).toLocaleString()),
            ...(entries.some(entry => entry.link) ? { Target: common(entry => entry.link || '—') } : {})
        };
        for (const [key, value] of Object.entries(values)) {
            const recursive = key === 'Total size' && entries.some(entry => entry.directory && !entry.symlink);
            details.append(el('dt', '', key), recursive ? folderSize(paths, lifetime.signal) : el('dd', '', value));
        }
        const label = el('label', 'field', 'Permissions (octal)'), input = el('input'), mode = common(entry => entry.mode);
        input.value = mode === 'Multiple' ? '' : mode;
        input.placeholder = mode; input.required = true; input.pattern = '[0-7]{3,4}'; input.setAttribute('aria-label', 'Permissions');
        label.append(input);
        const permissions = el('div', 'permissions-row');
        permissions.append(label, button('Apply', undefined, async () => {
            if (!input.reportValidity()) return;
            try { for (const entry of entries) await api('/files', 'POST', { operation: 'chmod', path: entry.path, mode: input.value }); close(); }
            finally { await this.refresh(); }
        }, 'primary'));
        content.append(details, permissions);
        if (entries.length === 1 && entries[0].directory) {
            const actions = el('div', 'actions');
            const workspaceDefault = button('Workspace default', 'House', () => this.workspaceDefault(entries[0].path));
            workspaceDefault.append(el('span', '', 'Workspace default'));
            actions.append(workspaceDefault);
            content.append(actions);
        }
        const { close, dialog } = modal('Properties', content);
        dialog.addEventListener('close', () => lifetime.abort(), { once: true });
        this.events.signal.addEventListener('abort', () => { lifetime.abort(); close(); }, { once: true, signal: lifetime.signal });
    }
    private async workspaceDefault(path: string) {
        await this.hooks.workspaceDefault(path);
        this.notice('Workspace default updated');
    }
    private menu(anchor: HTMLElement | { x: number; y: number }, background = !this.selected.size, overflow: HTMLButtonElement[] = []) {
        const content = el('div', 'menu-actions');
        scopeNotifications(content, this.root);
        let close = () => {};
        const chosen = this.chosen();
        const directory = background ? this.panel.path : chosen.length === 1 && chosen[0].directory ? chosen[0].path : undefined;
        for (const source of overflow) {
            const item = button(source.title, undefined, () => { close(); source.click(); });
            item.replaceChildren(...[...source.childNodes].map(node => node.cloneNode(true)), el('span', '', source.title));
            item.disabled = source.disabled; item.setAttribute('role', 'menuitem'); content.append(item);
        }
        if (overflow.length) content.append(el('hr', 'menu-separator'));
        for (const [label, name, action] of this.inTrash ? (background ? [
            ['Empty bin', 'Trash2', () => this.emptyTrash()]
        ] as const : [
            ['Restore', 'Undo2', () => this.restore()], ['Delete permanently', 'Trash2', () => this.remove(true)]
        ] as const) : background ? [
            ['New file', 'FilePlus', () => this.createFile()], ['New folder', 'FolderPlus', () => this.mkdir()], ['Paste', 'ClipboardPaste', () => this.paste()], ['Workspace default', 'House', () => this.workspaceDefault(directory!)], ['Properties', 'Info', () => this.properties()]
        ] as const : [
            ['Open', 'FilePenLine', () => this.openFile()], ['Compress…', 'Archive', () => this.archiveDialog()], ['Extract…', 'FolderOpen', () => this.archiveDialog(true)],
            ['Cut', 'Scissors', () => this.copySelection(true)], ['Copy', 'Copy', () => this.copySelection()], ['Paste', 'ClipboardPaste', () => this.paste()],
            ['Rename', 'Pencil', () => this.rename()], ['Copy to…', 'Copy', () => this.transferPrompt('copy')], ['Move to…', 'MoveRight', () => this.transferPrompt('move')], ['Download', 'Download', () => this.downloadSelected()], ['Workspace default', 'House', () => this.workspaceDefault(directory!)], ['Properties', 'Info', () => this.properties()], ['Delete', 'Trash2', () => this.remove()]
        ] as const) {
            if (overflow.some(source => source.title === label)) continue;
            if (label === 'Workspace default' && !directory) continue;
            const b = button(label, name, () => { close(); return action(); });
            b.disabled = this.actionButtons.find(source => source.title === label)?.disabled || false;
            b.append(el('span', '', label)); b.setAttribute('role', 'menuitem');
            content.append(b);
        }
        ({ close } = popover(anchor, content));
        this.closeMenu = close;
    }
    private async uploadFiles(files: UploadSource[], point?: { clientX: number; clientY: number }) {
        try {
            const uploaded = await uploadBatch(this.panel.path, files, this.root, this.events.signal);
            if (!this.disposed && point) animateFileDrop(uploaded, point, this.list);
        }
        catch { /* The batch indicator owns upload errors and cancellation. */ }
        this.uploadInput.value = '';
    }
    dispose() { this.cancelSelection?.(); this.rowMenus.splice(0).forEach(dispose => dispose()); this.inspector?.dispose(); this.disposed = true; this.events.abort(); instances.delete(this); this.request?.abort(); }
}
