import { api, ask, bindContextMenu, button, confirmAction, el, icon, modal, notify, popover, scopeNotifications, size } from './ui';
import { download, downloadArchive, upload, uploadBatch, type UploadSource, operation as trackOperation } from './transfers';
import { join, type Panel, type Hooks, type View } from './model';
import { FileInspector } from './editor';
import { fittingHeaderItemCount } from './overflow';
import { registerFileDrop, registerUploadInput, setDropFeedback, animateFileDrop, startFileDrag, type DraggedFile } from './file-drag';
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
};
const instances = new Set<FileView>();
const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export class FileView implements View {
    private entries: Entry[] = [];
    private selected = new Set<string>();
    private list = el('div', 'file-list');
    private pathInput = el('input', 'path-input');
    private nav = el('form', 'file-nav');
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
    constructor(private root: HTMLElement, private panel: Panel, private hooks: Hooks) {
        instances.add(this);
        window.addEventListener('tuxee-files-uploaded', event => {
            for (const path of (event as CustomEvent<Set<string>>).detail) this.uploadedDirectories.add(path);
            if (!this.request) this.refreshUploaded();
        }, { signal: this.events.signal });
        root.classList.add('file-view');
        this.pathInput.value = panel.path || hooks.user.home;
        this.pathInput.setAttribute('aria-label', 'Directory path');
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
        this.pathInput.onblur = () => { this.pathInput.value = this.panel.path; this.pathInput.scrollLeft = 0; };
        this.pathInput.onkeydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); this.pathInput.blur(); }
        };
        this.nav.append(this.pathInput);
        this.nav.onsubmit = event => {
            event.preventDefault();
            this.navigate(this.pathInput.value).then(() => {
                if (this.pathInput.value === this.panel.path) this.pathInput.blur();
            }).catch(this.notice);
        };
        root.closest('.panel')!.querySelector('.panel-title')!.remove();
        const actions = el('div', 'file-actions');
        const actionButtons = [button('Parent directory', 'ArrowUp', () => this.navigate(this.panel.path.split('/').slice(0, -1).join('/') || '/'), 'file-navigation'), button('Home directory', 'House', () => this.navigate(hooks.user.home), 'file-navigation'), button('Refresh files', 'RefreshCw', () => this.refresh()), button('New folder', 'FolderPlus', () => this.mkdir()), button('New file', 'FilePlus', () => this.createFile()), button('Upload files', 'Upload', () => this.uploadInput.click()), button('Download selected', 'Download', () => this.downloadSelected()), button('Copy selected', 'Copy', () => this.transferPrompt('copy')), button('Move selected', 'MoveRight', () => this.transferPrompt('move')), button('Open terminal here', 'SquareTerminal', () => this.hooks.openTerminal(this.panel.path))];
        const separator = el('span', 'file-navigation-separator', '|'); separator.setAttribute('aria-hidden', 'true');
        const actionItems = [...actionButtons.slice(0, 2), separator, ...actionButtons.slice(2)];
        const more = button('File actions', 'Ellipsis', () => this.menu(more, !this.selected.size, actionButtons.filter(item => item.hidden)));
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
        registerFileDrop(dropTarget, {
            over: drop => { setDropFeedback(root, drop.copy ? 'Copy here' : 'Move here'); return drop.copy || drop.source !== panel.id; },
            leave: () => setDropFeedback(root),
            drop: drop => {
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
        registerUploadInput(dropTarget, {
            accept: () => !this.disposed && !this.inspector,
            over: () => setDropFeedback(root, 'Upload'),
            leave: () => setDropFeedback(root),
            upload: (sources, point) => { void this.uploadFiles(sources, point); }
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
        root.append(actions, header, this.list, footer, this.uploadInput);
        this.resize();
        const fitActions = () => {
            if (!actions.getClientRects().length) return;
            this.closeMenu();
            actionItems.forEach(item => { item.hidden = false; });
            const style = getComputedStyle(actions), gap = parseFloat(style.columnGap) || 0;
            const available = actions.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            // Count the permanent menu button too, so it always retains its space.
            const count = fittingHeaderItemCount([...actionItems, more].map(item => item.getBoundingClientRect().width), available, more.getBoundingClientRect().width, gap);
            actionItems.forEach((item, index) => { item.hidden = index >= count; });
            if (actionButtons.some(item => item.hidden && item === document.activeElement)) more.focus();
        };
        const observer = new ResizeObserver(fitActions); observer.observe(actions); fitActions();
        this.events.signal.addEventListener('abort', () => { observer.disconnect(); this.closeMenu(); }, { once: true });
        this.navigate(this.pathInput.value).catch(this.notice);
    }
    private notice = (value: unknown) => notify(value, this.root);
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
            const response = await api('/files', 'POST', { operation: 'list', path }, request.signal);
            if (this.disposed || request.signal.aborted)
                return;
            this.panel.path = response.path;
            this.pathInput.title = response.path;
            this.hooks.title?.(this.title);
            if (this.pathInput.value === previousInput)
                this.pathInput.value = response.path;
            this.entries = response.entries || [];
            if (previousPath !== response.path) { this.selected.clear(); this.filter = this.filterInput.value = ''; this.selectionAnchor = ''; }
            else this.selected = new Set(this.entries.filter(entry => this.selected.has(entry.path)).map(entry => entry.path));
            const focusStillHere = document.activeElement === focusOwner || this.list.contains(document.activeElement);
            this.render();
            if (restoreFocus && focusStillHere) this.focus(focused);
            this.hooks.changed();
            if (response.truncated)
                this.status.textContent += ' · First 10,000 entries';
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
    private get title() { return this.panel.path.split('/').filter(Boolean).at(-1) || 'Files'; }
    private visibleEntries() {
        const query = this.filter.toLocaleLowerCase(), entries = this.entries.filter(entry =>
            (this.showHidden.checked || !entry.name.startsWith('.')) && entry.name.toLocaleLowerCase().includes(query));
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
            row.append(select, name, el('span', 'file-size', entry.directory ? '—' : size(entry.size)), el('span', 'file-date', new Date(entry.modified).toLocaleDateString()));
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
                if (twice) (entry.directory ? this.navigate(entry.path) : this.openFile(entry)).catch(this.notice);
            };
            this.rowMenus.push(bindContextMenu(row, position => { if (!this.selected.has(entry.path)) {
                this.selected.clear();
                this.selected.add(entry.path);
                this.paintSelection();
            } row.focus({ preventScroll: true }); this.menu(position || row); }, true));
            row.onpointerdown = e => {
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
        else if (e.key === 'ArrowLeft') run(() => this.navigate(this.panel.path.split('/').slice(0, -1).join('/') || '/', this.panel.path));
        else if (e.key === 'ArrowRight' || e.key === 'Enter') run(() => entry?.directory ? this.navigate(entry.path, '') : e.key === 'Enter' && entry ? this.openFile(entry) : undefined);
        else if (e.key === ' ' && entry) run(() => { if (this.selected.has(entry.path)) this.selected.delete(entry.path); else this.selected.add(entry.path); this.selectionAnchor = entry.path; this.paintSelection(); });
        else if (e.key === 'Delete') run(() => this.remove());
        else if (e.key === 'F2') run(() => this.rename());
        else if (e.key === 'F5') run(() => this.refresh());
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
    private paintSelection() {
        const rows = this.list.querySelectorAll<HTMLElement>('.file-entry');
        let selected = 0;
        for (const row of rows) {
            const checked = this.selected.has(row.dataset.path!);
            row.setAttribute('aria-selected', String(checked));
            row.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = checked;
            if (checked) selected++;
        }
        this.selectAll.checked = rows.length > 0 && selected === rows.length;
        this.selectAll.indeterminate = selected > 0 && selected < rows.length;
        this.selectAll.disabled = !rows.length;
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
    private async remove() {
        const entries = this.chosen();
        if (!entries.length)
            throw new Error('Select files to delete');
        if (!await confirmAction('Delete selected items?', `Permanently delete ${entries.length} item(s), including any folder contents? There is no trash recovery.`, 'Delete'))
            return;
        try {
            for (const entry of entries)
                await api('/files', 'POST', { operation: 'delete', path: entry.path });
        }
        finally {
            await this.refresh();
        }
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
    private async transfer(entries: DraggedFile[], path: string, operation: 'copy' | 'move') {
        if (!path.startsWith('/')) throw new Error('Use an absolute destination path');
        entries = entries.filter(entry => operation !== 'move' || entry.path !== join(path, entry.name));
        if (!entries.length) return [];
        const paths: string[] = [];
        try {
            await trackOperation(operation === 'copy' ? 'Copy' : 'Move', entries.length, async (signal, progress) => {
                for (const [index, entry] of entries.entries()) {
                    const result = await api('/files', 'POST', { operation, path: entry.path, destination: join(path, entry.name) }, signal);
                    paths.push(result.path);
                    progress(index + 1);
                }
            }, this.root);
            return paths;
        } finally {
            await Promise.all([...instances].map(view => view.refresh().catch(() => {})));
        }
    }
    private async openFile(entry = this.single()) {
        if (entry.directory) return this.navigate(entry.path, '');
        if (/\.(zip|7z|tar|tgz|tbz2|txz|tar\.(gz|bz2|xz))$/i.test(entry.name)) return this.archiveDialog(true);
        if (this.inspector && !await this.inspector.canClose()) return;
        this.inspector?.dispose();
        this.inspector = new FileInspector(this.root, this.visibleEntries().filter(file => !file.directory), entry.path, () => { this.inspector = undefined; this.focus(entry.path); this.refresh().catch(this.notice); });
    }
    canClose = () => this.inspector?.canClose() ?? Promise.resolve(true);
    private async archiveDialog(extract = false) {
        const entries = extract ? [this.single()] : this.chosen();
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
        const common = (get: (entry: any) => unknown) => entries.every(entry => get(entry) === get(entries[0])) ? String(get(entries[0])) : 'Multiple';
        const content = el('div', 'form'), details = el('dl', 'properties');
        scopeNotifications(content, this.root);
        const values = {
            Name: entries.length === 1 ? entries[0].name : `${entries.length} items`, Path: common(entry => entry.path),
            Type: common(entry => entry.symlink ? 'Symbolic link' : entry.directory ? 'Directory' : 'File'),
            [entries.some(entry => entry.directory) ? 'Size (entries)' : 'Total size']: size(entries.reduce((sum, entry) => sum + entry.size, 0)),
            'Owner UID': common(entry => entry.uid), 'Group GID': common(entry => entry.gid),
            Modified: common(entry => new Date(entry.modified).toLocaleString()), Accessed: common(entry => new Date(entry.accessed).toLocaleString()),
            'Metadata changed': common(entry => new Date(entry.changed).toLocaleString()),
            ...(entries.some(entry => entry.link) ? { Target: common(entry => entry.link || '—') } : {})
        };
        for (const [key, value] of Object.entries(values)) details.append(el('dt', '', key), el('dd', '', value));
        const label = el('label', 'field', 'Permissions (octal)'), input = el('input'), mode = common(entry => entry.mode);
        input.value = mode === 'Multiple' ? '' : mode;
        input.placeholder = mode; input.required = true; input.pattern = '[0-7]{3,4}'; input.setAttribute('aria-label', 'Permissions');
        label.append(input);
        content.append(details, label, button('Save permissions', undefined, async () => {
            if (!input.reportValidity()) return;
            try { for (const entry of entries) await api('/files', 'POST', { operation: 'chmod', path: entry.path, mode: input.value }); close(); }
            finally { await this.refresh(); }
        }, 'primary'));
        const { close } = modal('Properties', content);
    }
    private menu(anchor: HTMLElement | { x: number; y: number }, background = !this.selected.size, overflow: HTMLButtonElement[] = []) {
        const content = el('div', 'menu-actions');
        scopeNotifications(content, this.root);
        let close = () => {};
        for (const source of overflow) {
            const item = button(source.title, undefined, () => { close(); source.click(); });
            item.replaceChildren(...[...source.childNodes].map(node => node.cloneNode(true)), el('span', '', source.title));
            item.disabled = source.disabled; item.setAttribute('role', 'menuitem'); content.append(item);
        }
        if (overflow.length) content.append(el('hr', 'menu-separator'));
        for (const [label, name, action] of background ? [
            ['New file', 'FilePlus', () => this.createFile()], ['New folder', 'FolderPlus', () => this.mkdir()], ['Properties', 'Info', () => this.properties()]
        ] as const : [
            ['Open', 'FilePenLine', () => this.openFile()], ['Compress…', 'Archive', () => this.archiveDialog()], ['Extract…', 'FolderOpen', () => this.archiveDialog(true)],
            ['Rename', 'Pencil', () => this.rename()], ['Copy to…', 'Copy', () => this.transferPrompt('copy')], ['Move to…', 'MoveRight', () => this.transferPrompt('move')], ['Download', 'Download', () => this.downloadSelected()], ['Properties', 'Info', () => this.properties()], ['Delete', 'Trash2', () => this.remove()]
        ] as const) {
            const b = button(label, name, () => { close(); return action(); });
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
