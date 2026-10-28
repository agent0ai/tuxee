import { locale, errorText, t } from './i18n';
import { api, ask, bindContextMenu, button, confirmAction, el, icon, modal, notify, popover, scopeNotifications, focusPanelChrome } from './ui';
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
export class FileView implements View {
    get pinned() { return !!this.panel.pinned; }
    private entries: Entry[] = [];
    private nameOrder = new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' });
    private selected = new Set<string>();
    private list = el('div', 'file-list');
    private pathInput = el('input', 'path-input');
    private displayedPath = '';
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
    private filterButton = button(t("files.filterFiles"), 'Search', () => this.showFilter(this.filterInput.hidden));
    private showHidden = el('input');
    private hiddenFiles = false;
    private sort?: { column: 'name' | 'size' | 'modified'; descending: boolean };
    private cancelSelection?: () => void;
    private rowMenus: (() => void)[] = [];
    private closeMenu = () => {};
    private selectAll = el('input');
    private inspector?: FileInspector;
    private uploadInput = el('input');
    private pasteInput: (data: DataTransfer) => boolean;
    private actionButtons: HTMLButtonElement[] = [];
    private propertiesButton = button(t("common.properties"), 'Info', () => this.properties());
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
        focusPanelChrome(root, () => { if (this.inspector) this.inspector.focus(); else this.focus(this.focusedPath); }, this.events.signal);
        this.pathInput.value = panel.path || hooks.defaultDirectory();
        this.pathInput.setAttribute('aria-label', t("files.fileOrDirectoryPath"));
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
        this.pathInput.onblur = () => { this.pathInput.value = this.displayedPath || this.panel.path; this.pathInput.scrollLeft = 0; };
        this.pathInput.onkeydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); this.pathInput.blur(); }
        };
        this.modified.hidden = true; this.modified.title = t("files.unsavedChanges"); this.modified.setAttribute('aria-label', t("files.unsavedChanges"));
        this.nav.append(this.pathInput, this.modified);
        this.nav.onsubmit = event => {
            event.preventDefault();
            this.openPath(this.pathInput.value).catch(this.notice);
        };
        root.closest('.panel')!.querySelector('.panel-title')!.remove();
        const actions = el('div', 'file-actions');
        const actionButtons = this.actionButtons = [button(t("files.parentDirectory"), 'ArrowUp', () => this.parent(), 'file-navigation'), button(t("app.homeDirectory"), 'House', () => this.navigate(hooks.defaultDirectory()), 'file-navigation'), button(t("files.trashBin"), 'Trash2', () => this.navigate(trashPath), 'file-navigation'), button(t("files.restore"), 'Undo2', () => this.restore()), button(t("files.emptyBin"), 'Trash2', () => this.emptyTrash()), button(t("files.refreshFiles"), 'RefreshCw', () => this.refresh()), button(t("files.newFolder"), 'FolderPlus', () => this.mkdir()), button(t("files.newFile"), 'FilePlus', () => this.createFile()), button(t("files.uploadFiles"), 'Upload', () => this.uploadInput.click()), button(t("files.downloadSelected"), 'Download', () => this.downloadSelected()), button(t("common.cut"), 'Scissors', () => this.copySelection(true)), button(t("common.copy"), 'Copy', () => this.copySelection()), button(t("common.paste"), 'ClipboardPaste', () => this.paste()), button(t("files.openTerminalHere"), 'SquareTerminal', () => this.hooks.openTerminal(this.panel.path))];
        const actionIDs = ['parent', 'home', 'trash', 'restore', 'empty', 'refresh', 'mkdir', 'create', 'upload', 'download', 'cut', 'copy', 'paste', 'terminal'];
        actionButtons.forEach((button, index) => button.dataset.action = actionIDs[index]);
        const separator = el('span', 'file-navigation-separator', '|'); separator.setAttribute('aria-hidden', 'true');
        const trashSeparator = separator.cloneNode(true) as HTMLElement;
        const trashItems = [actionButtons[3], actionButtons[4], trashSeparator];
        const actionItems = [...actionButtons.slice(0, 3), separator, ...trashItems, ...actionButtons.slice(5)];
        const more = button(t("files.fileActions"), 'Ellipsis', () => this.menu(more, !this.selected.size, actionButtons.filter(item => item.hidden && (this.inTrash || !trashItems.includes(item)))));
        more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
        actions.append(...actionItems, more);
        this.uploadInput.type = 'file';
        this.uploadInput.multiple = true;
        this.uploadInput.hidden = true;
        this.uploadInput.onchange = () => this.uploadFiles([...this.uploadInput.files || []]);
        const header = el('div', 'file-columns');
        const selectAll = el('label', 'file-select');
        this.selectAll.type = 'checkbox';
        this.selectAll.setAttribute('aria-label', t("files.selectAllVisibleFiles"));
        this.selectAll.onchange = () => {
            for (const entry of this.visibleEntries()) {
                if (this.selectAll.checked) this.selected.add(entry.path); else this.selected.delete(entry.path);
            }
            this.paintSelection();
        };
        selectAll.append(this.selectAll); header.append(selectAll);
        for (const [column, label] of [['name', t("common.name")], ['size', t("common.size")], ['modified', t("common.modified")]] as const) {
            const heading = button(t("files.sortBy", { column: label }), undefined, () => {
                this.sort = this.sort?.column !== column ? { column, descending: false } : !this.sort.descending ? { column, descending: true } : undefined;
                for (const item of header.querySelectorAll('button')) {
                    const active = item.dataset.column === this.sort?.column;
                    item.setAttribute('aria-pressed', String(active));
                    item.setAttribute('aria-description', active ? this.sort!.descending ? t("files.descending") : t("files.ascending") : t("files.defaultOrder"));
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
        this.list.setAttribute('aria-label', t("common.files"));
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
            over: drop => { if (this.inTrash) return false; setDropFeedback(root, drop.copy ? t("files.copyHere") : t("files.moveHere"), drop.copy ? '' : t("files.copyModifierHint")); return drop.copy || drop.source !== panel.id; },
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
            over: () => setDropFeedback(root, t("common.upload")),
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
        this.filterInput.placeholder = t("files.filter"); this.filterInput.setAttribute('aria-label', t("files.filterFiles"));
        this.filterInput.autocomplete = 'off'; this.filterInput.spellcheck = false;
        this.filterButton.setAttribute('aria-expanded', 'false');
        this.filterInput.oninput = () => { this.filter = this.filterInput.value; this.render(); };
        this.filterInput.onkeydown = e => {
            if (e.isComposing) return;
            if (e.key === 'Escape') { e.preventDefault(); this.showFilter(false); }
            else if (["Enter", 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); this.focus(this.focusedPath); }
        };
        const hiddenSeparator = el('span', 'file-footer-separator', '|'); hiddenSeparator.setAttribute('aria-hidden', 'true');
        const hiddenLabel = el('label', 'file-hidden');
        this.showHidden.type = 'checkbox';
        this.showHidden.onchange = () => { this.hiddenFiles = this.showHidden.checked; this.render(); };
        hiddenLabel.append(this.showHidden, t("files.hidden"));
        const pin = button(t("files.pinCurrentFolder"), 'Pin', () => {
            this.panel.pinned = !this.pinned;
            pin.setAttribute('aria-pressed', String(this.pinned));
            this.hooks.changed();
        });
        pin.setAttribute('aria-pressed', String(this.pinned)); pin.dataset.action = 'pin';
        footer.append(this.filterButton, this.filterInput, hiddenSeparator, hiddenLabel, this.status, pin, this.propertiesButton);
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
        if (this.displayedPath === path && this.modified.hidden === !dirty) return;
        this.pathInput.title = this.displayedPath = path;
        if (document.activeElement !== this.pathInput) this.pathInput.value = path;
        this.modified.hidden = !dirty;
        this.hooks.title?.((path === trashPath ? t("files.trashBin") : path.split('/').filter(Boolean).at(-1) || t("common.files")) + (dirty ? ' •' : ''));
    };
    async openPath(path: string, line?: number, column?: number): Promise<boolean> {
        if (path === trashPath) {
            if (this.inspector) await this.inspector.leave(async () => { if (await this.navigate(path)) { this.inspector?.dispose(); this.inspector = undefined; this.showPath(path); } });
            else await this.navigate(path);
            return this.panel.path === path && !this.inspector;
        }
        this.request?.abort();
        const request = this.request = new AbortController();
        try {
            const { entry } = await api('/files', 'POST', { operation: 'stat', path }, request.signal);
            if (request.signal.aborted || this.disposed) return false;
            if (entry.directory) {
                let opened = false;
                const navigate = async () => {
                    if (request.signal.aborted || this.disposed) return;
                    this.request = undefined;
                    if (!await this.navigate(entry.path)) return;
                    this.inspector?.dispose(); this.inspector = undefined;
                    this.showPath(this.panel.path);
                    opened = true;
                };
                if (this.inspector) await this.inspector.leave(navigate);
                else await navigate();
                if (!opened) return false;
            } else if (!await this.openFile(entry, request.signal, line, column)) return false;
            if (this.pathInput.value === path || this.pathInput.value === this.displayedPath) this.pathInput.blur();
            return true;
        } catch (error) {
            if (!request.signal.aborted) throw error;
            return false;
        } finally {
            if (this.request === request) this.request = undefined;
        }
    }
    focusOpened() { if (this.inspector) this.inspector.focus(); else this.focus(''); }
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
        this.status.textContent = t("common.loading");
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
                this.status.textContent += t("files.listTruncated", { count: this.entries.length });
            return true;
        }
        catch (error) {
            if (!request.signal.aborted) {
                this.status.textContent = error instanceof Error ? errorText(error) : t("files.cannotReadDirectory");
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
            (this.inTrash || this.hiddenFiles || !entry.name.startsWith('.')) && entry.name.toLocaleLowerCase().includes(query));
        if (this.sort) {
            const { column, descending } = this.sort;
            entries.sort((a, b) => ((column === 'size' ? a.size - b.size : column === 'modified' ? Date.parse(a.modified) - Date.parse(b.modified) : this.nameOrder.compare(a.name, b.name)) || a.name.localeCompare(b.name)) * (descending ? -1 : 1));
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
        if (!entries.length) this.list.append(el('div', 'empty', this.filter ? t("files.noMatches") : t("files.emptyFolder")));
        for (const entry of entries) {
            const row = el('div', 'file-entry');
            row.dataset.path = entry.path;
            row.dataset.directory = String(entry.directory);
            if (entry.originalPath) row.title = `${entry.originalPath}${entry.deleted ? t("files.deletionDate", { date: entry.deleted.replace('T', ' ') }) : ''}`;
            row.tabIndex = -1;
            row.addEventListener('focusin', () => { this.focusedPath = entry.path; });
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', 'false');
            const select = el('label', 'file-select'), checkbox = el('input');
            checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', t("files.selectName", { name: entry.name }));
            checkbox.onchange = () => {
                if (checkbox.checked) this.selected.add(entry.path); else this.selected.delete(entry.path);
                this.selectionAnchor = entry.path; this.paintSelection();
            };
            checkbox.onkeydown = event => { if (event.key === ' ') event.stopPropagation(); };
            select.onclick = select.ondblclick = event => event.stopPropagation();
            select.onpointerdown = event => { this.lastTap = undefined; event.stopPropagation(); this.startCheckSelection(event, entry.path); };
            select.append(checkbox);
            const name = el('span', 'file-name');
            const filename = el('span', '', entry.name); filename.dir = 'auto';
            name.append(icon(entry.directory ? 'Folder' : entry.symlink ? 'Link' : 'File'), filename);
            const bytes = el('span', 'file-size', entry.directory ? '—' : compactSize(entry.size, 1024));
            if (!entry.directory) bytes.title = `${entry.size.toLocaleString(locale())} B`;
            row.append(select, name, bytes, el('span', 'file-date', new Date(entry.modified).toLocaleDateString(locale())));
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
        if (cut) row.setAttribute('aria-description', t("common.cut")); else row.removeAttribute('aria-description');
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
        this.showHidden.checked = this.inTrash || this.hiddenFiles;
        this.propertiesButton.disabled = this.inTrash && !this.selected.size;
        for (const action of this.actionButtons) {
            action.disabled = ['download', 'cut', 'copy'].includes(action.dataset.action!) ? !this.selected.size || this.inTrash
                : action.dataset.action === 'restore' ? !this.selected.size
                : action.dataset.action === 'empty' ? !this.entries.length
                : this.inTrash && ['mkdir', 'create', 'upload', 'paste', 'terminal'].includes(action.dataset.action!);
        }
        this.status.textContent = t("files.selectionSummary", { count: this.filter || rows.length !== this.entries.length ? `${rows.length}/${this.entries.length}` : this.entries.length, selection: this.selected.size ? t('files.selectedCount', { count: this.selected.size }) : '' });
    }
    private single() { const values = this.chosen(); if (values.length !== 1)
        throw new Error(t("files.selectOneItemFirst")); return values[0]; }
    private async mkdir() { const name = await ask(t("files.newFolder"), t("files.folderName")); if (!name)
        return; this.checkName(name); await api('/files', 'POST', { operation: 'mkdir', path: join(this.panel.path, name) }); await this.refresh(); }
    private async createFile() { const name = await ask(t("files.newFile"), t("files.fileName")); if (!name)
        return; this.checkName(name); await upload(join(this.panel.path, name), new File([], name), this.events.signal); await this.refresh(); }
    private checkName(name: string) { if (name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
        throw new Error(t("files.useAFilenameWithoutSlashes")); }
    private async rename() { const entry = this.single(), name = await ask(t("common.rename"), t("files.newName"), entry.name); if (!name || name === entry.name)
        return; this.checkName(name); await api('/files', 'POST', { operation: 'rename', path: entry.path, destination: join(this.panel.path, name) }); await this.refresh(); }
    private async remove(permanent = false) {
        const entries = this.chosen(), inTrash = this.inTrash;
        if (!entries.length)
            throw new Error(t("files.selectFilesToDelete"));
        const folders = entries.filter(entry => entry.directory && !entry.symlink).length, files = entries.length - folders;
        const summary = [files ? t(files === 1 ? 'count.file' : 'count.files', { count: files }) : '', folders ? t(folders === 1 ? 'count.folder' : 'count.folders', { count: folders }) : ''].filter(Boolean).join(', ');
        const choice = await new Promise<boolean | undefined>(resolve => {
            const content = el('div', 'form'), checkbox = el('input'), label = el('label', 'file-delete-permanent');
            checkbox.type = 'checkbox'; checkbox.checked = permanent || inTrash; checkbox.disabled = inTrash;
            label.append(checkbox, t("files.deletePermanentlyInstead"));
            const message = el('p', 'muted'), actions = el('div', 'actions');
            const submit = button('', undefined, () => { resolve(checkbox.checked); dialog.close(); }, 'primary');
            const update = () => {
                message.textContent = checkbox.checked ? t("files.permanentConfirm", { items: summary }) : t("files.trashConfirm", { items: summary });
                submit.textContent = submit.title = checkbox.checked ? t("files.deletePermanently") : t("files.moveToBin");
                submit.setAttribute('aria-label', submit.title);
            };
            checkbox.onchange = update; update();
            content.append(message);
            if (!inTrash) content.append(label);
            const { dialog } = modal(t("files.deleteSelectedItems"), content);
            actions.append(button(t("common.cancel"), undefined, () => dialog.close()), submit); content.append(actions); submit.focus();
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
        if (!await confirmAction(t("files.emptyTrashBin"), t("files.permanentlyDeleteEverythingInTheTrashBin"), t("files.emptyBin"))) return;
        try { await api('/files', 'POST', { operation: 'trash-empty' }, this.events.signal); }
        finally { this.refreshTrash(entries); }
    }
    private async downloadSelected() {
        const entries = this.chosen();
        if (!entries.length) throw new Error(t("files.selectFilesOrFoldersToDownload"));
        if (entries.length > 1 || entries[0].directory) return downloadArchive(this.panel.path, entries.map(entry => entry.path), this.root);
        await download(entries[0].path, entries[0].name, this.root);
    }
    private async transferPrompt(operation: 'copy' | 'move') { const entries = this.chosen(); if (!entries.length)
        throw new Error(t("file.clipboard.selectFilesFirst")); const path = await ask(t(operation === 'copy' ? 'files.copySelected' : 'files.moveSelected'), t("files.destinationDirectoryAbsolutePath"), this.panel.path); if (path)
        await this.transfer(entries, path, operation); }
    private copySelection(cut = false, event?: ClipboardEvent) { copyFiles(this.chosen(), this.hooks.user.uid, cut, event); }
    private async paste() {
        this.list.focus({ preventScroll: true });
        const path = this.panel.path, data = await readDeviceClipboard();
        if (this.disposed || this.inspector || path !== this.panel.path) return;
        if (!this.pasteInput(data)) this.notice(t("files.noTuxeeFilesOnTheClipboard"));
    }
    private async transfer(entries: DraggedFile[], path: string, operation: 'copy' | 'move', settled?: (path: string, error?: unknown) => void) {
        if (!path.startsWith('/')) throw new Error(t("files.useAnAbsoluteDestinationPath"));
        entries = entries.filter(entry => operation !== 'move' || entry.path !== join(path, entry.name));
        if (!entries.length) return [];
        const paths: string[] = [];
        try {
            await trackOperation(operation === 'copy' ? t("common.copy") : t("files.move"), entries.length, async (signal, progress) => {
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
    private async openFile(entry = this.single(), signal?: AbortSignal, line?: number, column?: number): Promise<boolean> {
        if (!signal) this.request?.abort();
        if (entry.directory) return !!await this.navigate(entry.path, '');
        if (this.inspector && !await this.inspector.canClose()) return false;
        if (this.disposed || signal?.aborted) return false;
        if (/\.(zip|7z|tar|tgz|tbz2|txz|tar\.(gz|bz2|xz))$/i.test(entry.name)) { await this.archiveDialog(true, entry); return true; }
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
        }, this.showPath, this.hooks, line, column);
        return true;
    }
    canClose = () => this.inspector?.canClose() ?? Promise.resolve(true);
    private async archiveDialog(extract = false, entry?: Entry) {
        const entries = extract ? [entry || this.single()] : this.chosen();
        if (!entries.length) throw new Error(t("file.clipboard.selectFilesFirst"));
        const capabilities = await api('/files', 'POST', { operation: 'archive-formats', path: this.panel.path });
        const content = el('form', 'form'), filename = el('input'), format = el('select'), password = el('input');
        scopeNotifications(content, this.root);
        const base = entries.length === 1 ? entries[0].name.replace(/\.(tar\.(gz|bz2|xz)|tgz|tbz2|txz|zip|7z|tar)$/i, '') : t('files.archive');
        filename.required = true; filename.setAttribute('aria-label', extract ? t("files.extractFolder") : t("files.archiveName"));
        password.type = 'password'; password.autocomplete = 'off'; password.setAttribute('aria-label', t("files.archivePassword"));
        const field = (title: string, input: HTMLElement) => { const label = el('label', 'field', title); label.append(input); content.append(label); return label; };
        field(extract ? t('files.folder') : t('common.name'), filename);
        if (!extract) {
            format.setAttribute('aria-label', t("files.archiveFormat"));
            for (const value of capabilities.formats || []) { const option = el('option', '', value.name); option.value = value.name; format.append(option); }
            if (!format.options.length) throw new Error(t("files.installTarOr7zipToCreateArchives"));
            format.value = [...format.options].some(option => option.value === 'tar.gz') ? 'tar.gz' : format.options[0].value;
            field(t("files.format"), format);
        }
        const passwordField = field(t('login.password'), password);
        const update = () => { filename.value = extract ? base : `${base}.${format.value}`; passwordField.hidden = !extract && !capabilities.formats.find(value => value.name === format.value)?.password; if (passwordField.hidden) password.value = ''; };
        format.onchange = update; update();
        const actions = el('div', 'actions'), submit = button(extract ? t("files.extract") : t("files.compress")); submit.type = 'submit'; submit.className = 'primary';
        actions.append(button(t("common.cancel"), undefined, () => close()), submit); content.append(actions);
        const { close } = modal(extract ? t("files.extractArchive") : t("files.createArchive"), content);
        content.onsubmit = async event => {
            event.preventDefault(); if (!content.reportValidity()) return;
            try {
                this.checkName(filename.value); const secret = password.value; password.value = ''; submit.disabled = true;
                const request = { operation: extract ? 'extract' : 'compress', path: extract ? entries[0].path : this.panel.path, paths: extract ? undefined : entries.map(entry => entry.path), destination: join(this.panel.path, filename.value), format: extract ? undefined : format.value, password: secret };
                close();
                await trackOperation(extract ? t("files.extract") : t("files.compress"), 1, async (signal, progress) => { await api('/files', 'POST', request, signal); progress(1); }, this.root);
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
        const common = (get: (entry: any) => unknown) => entries.every(entry => get(entry) === get(entries[0])) ? String(get(entries[0])) : undefined;
        const content = el('div', 'form'), details = el('dl', 'properties');
        const lifetime = new AbortController();
        scopeNotifications(content, this.root);
        const values = {
            'files.property.name': entries.length === 1 ? entries[0].name : t("files.itemsCount", { count: entries.length }), 'files.property.path': common(entry => entry.path),
            'files.property.type': common(entry => t(entry.symlink ? 'files.symlink' : entry.directory ? 'common.directory' : 'files.file')),
            'files.property.size': compactSize(entries.reduce((sum, entry) => sum + (entry.directory && !entry.symlink ? 0 : entry.size), 0), 1024, true),
            'files.property.uid': common(entry => entry.uid), 'files.property.gid': common(entry => entry.gid),
            'files.property.modified': common(entry => new Date(entry.modified).toLocaleString(locale())), 'files.property.accessed': common(entry => new Date(entry.accessed).toLocaleString(locale())),
            'files.property.changed': common(entry => new Date(entry.changed).toLocaleString(locale())),
            ...(entries.some(entry => entry.link) ? { 'files.property.target': common(entry => entry.link || '—') } : {})
        };
        for (const [key, value] of Object.entries(values)) {
            const recursive = key === 'files.property.size' && entries.some(entry => entry.directory && !entry.symlink);
            details.append(el('dt', '', t(key)), recursive ? folderSize(paths, lifetime.signal) : el('dd', '', value ?? t('files.multiple')));
        }
        const label = el('label', 'field', t("files.permissionsOctal")), input = el('input'), mode = common(entry => entry.mode);
        input.value = mode ?? '';
        input.placeholder = mode ?? t('files.multiple'); input.required = true; input.pattern = '[0-7]{3,4}'; input.setAttribute('aria-label', t("common.permissions"));
        label.append(input);
        const permissions = el('div', 'permissions-row');
        permissions.append(label, button(t("files.apply"), undefined, async () => {
            if (!input.reportValidity()) return;
            try { for (const entry of entries) await api('/files', 'POST', { operation: 'chmod', path: entry.path, mode: input.value }); close(); }
            finally { await this.refresh(); }
        }, 'primary'));
        content.append(details, permissions);
        if (entries.length === 1 && entries[0].directory) {
            const actions = el('div', 'actions');
            const workspaceDefault = button(t("files.workspaceDefault"), 'House', () => this.workspaceDefault(entries[0].path));
            workspaceDefault.append(el('span', '', t("files.workspaceDefault")));
            actions.append(workspaceDefault);
            content.append(actions);
        }
        const { close, dialog } = modal(t("common.properties"), content);
        dialog.addEventListener('close', () => lifetime.abort(), { once: true });
        this.events.signal.addEventListener('abort', () => { lifetime.abort(); close(); }, { once: true, signal: lifetime.signal });
    }
    private async workspaceDefault(path: string) {
        await this.hooks.workspaceDefault(path);
        this.notice(t("files.workspaceDefaultUpdated"));
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
        for (const [id, label, name, action] of this.inTrash ? (background ? [
            ['empty', t("files.emptyBin"), 'Trash2', () => this.emptyTrash()]
        ] as const : [
            ['restore', t("files.restore"), 'Undo2', () => this.restore()], ['delete', t("files.deletePermanently"), 'Trash2', () => this.remove(true)]
        ] as const) : background ? [
            ['create', t("files.newFile"), 'FilePlus', () => this.createFile()], ['mkdir', t("files.newFolder"), 'FolderPlus', () => this.mkdir()], ['paste', t("common.paste"), 'ClipboardPaste', () => this.paste()], ['workspace-default', t("files.workspaceDefault"), 'House', () => this.workspaceDefault(directory!)], ['properties', t("common.properties"), 'Info', () => this.properties()]
        ] as const : [
            ['open', t("files.open"), 'FilePenLine', () => this.openFile()], ['compress', t("files.compressMenu"), 'Archive', () => this.archiveDialog()], ['extract', t("files.extractMenu"), 'FolderOpen', () => this.archiveDialog(true)],
            ['cut', t("common.cut"), 'Scissors', () => this.copySelection(true)], ['copy', 'Copy', 'Copy', () => this.copySelection()], ['paste', t("common.paste"), 'ClipboardPaste', () => this.paste()],
            ['rename', t("common.rename"), 'Pencil', () => this.rename()], ['copy-to', t("files.copyTo"), 'Copy', () => this.transferPrompt('copy')], ['move-to', t("files.moveTo"), 'MoveRight', () => this.transferPrompt('move')], ['download', 'Download', 'Download', () => this.downloadSelected()], ['workspace-default', t("files.workspaceDefault"), 'House', () => this.workspaceDefault(directory!)], ['properties', t("common.properties"), 'Info', () => this.properties()], ['delete', t("common.delete"), 'Trash2', () => this.remove()]
        ] as const) {
            if (overflow.some(source => source.dataset.action === id)) continue;
            if (id === 'workspace-default' && !directory) continue;
            const b = button(label, name, () => { close(); return action(); });
            b.disabled = this.actionButtons.find(source => source.dataset.action === id)?.disabled || false;
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
