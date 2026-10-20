import { GridStack } from 'gridstack';
import '@xterm/xterm/css/xterm.css';
import 'gridstack/dist/gridstack.css';
import './style.css';
import horizontalLogo from './tuxee-logo-horizontal.webp';
import emblemLogo from './tuxee-logo-emblem.webp';
import verticalLogo from './tuxee-logo-vertical.webp';
import horizontalLogoLight from './tuxee-logo-horizontal-light.webp';
import emblemLogoLight from './tuxee-logo-emblem-light.webp';
import verticalLogoLight from './tuxee-logo-vertical-light.webp';
import { api, ask, bindContextMenu, button, confirmAction, el, icon, modal, notify, popover, scopeNotifications, setCSRF } from './ui';
import { addCompact, gridDrop, dropLayout, sharedDividers, resizeDividers, type Divider, newPanel, newWorkspace, split, validGrid, type Edge, type Kind, type Panel, type Settings, type User, type View, type Workspace, type TerminalInfo, screenSnap, snapLayout, cycleLayout, expandPanel, expandAfterClose, type Rect } from './model';
import { overflowTabs } from './overflow';
import { FileView } from './files';
import { TerminalView, terminateTerminal } from './term';
import { cancelTransfers, prepareDownloads } from './transfers';
import { Monitoring } from './monitor';
import { BackendConnection } from './connection';
import { Updates } from './updates';
import { preventFileNavigation } from './file-drag';
preventFileNavigation();
const root = document.querySelector<HTMLElement>('#app')!;
let user: User, settings: Settings;
let loggedIn = false, saveTimer: ReturnType<typeof setTimeout> | undefined, savePromise = Promise.resolve();
let monitoring: Monitoring | undefined;
let connection: BackendConnection | undefined;
let updates: Updates | undefined;
let terminalSessions: TerminalInfo[] = [], terminalError = '';
let terminalRequest: AbortController | undefined, terminalTimer: ReturnType<typeof setTimeout> | undefined;
type Mounted = { ws: Workspace; board: HTMLElement; gridEl: HTMLElement; grid?: GridStack; compact: boolean; items: Map<string, { node: HTMLElement; view: View; tools: HTMLElement; title: HTMLElement }> };
let mounted: Mounted | undefined, outgoing: Mounted | undefined, slide: Animation | undefined;
const warmWorkspaces = new Map<string, Mounted>();
const MAX_WARM_WORKSPACES = 8;
let track: HTMLElement, viewportRoot: HTMLElement;
let dragging = false, cancelDrag = () => {};
let chromeDisposers: (() => void)[] = [];
const preview = el('div', 'dock-preview');
let previewRemoval: ReturnType<typeof setTimeout> | undefined;
type DropTarget = { layout: Panel[]; rect: Rect } | { target: Panel; edge: Edge | 'center' };
const duration = (ms: number) => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
function showPreview(parent: HTMLElement, rect: Rect, edge: string, invalid: boolean) {
    clearTimeout(previewRemoval);
    const entering = !preview.isConnected || preview.parentElement !== parent || (!preview.classList.contains('visible') && getComputedStyle(preview).opacity === '0');
    if (entering) preview.style.transition = 'none';
    preview.dataset.edge = edge; preview.classList.toggle('invalid', invalid);
    Object.assign(preview.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    if (preview.parentElement !== parent) parent.append(preview);
    if (entering) { void preview.offsetWidth; preview.style.transition = ''; }
    preview.classList.add('visible');
}
function hidePreview() {
    if (!preview.isConnected || !preview.classList.contains('visible')) return;
    preview.classList.remove('visible');
    clearTimeout(previewRemoval);
    if (!duration(80)) preview.remove();
    else previewRemoval = setTimeout(() => preview.remove(), 80);
}
const current = () => settings.workspaces.find(ws => ws.id === settings.current)!;
const changed = (immediate = false) => { if (!loggedIn)
    return; clearTimeout(saveTimer); if (immediate)
    return save(); saveTimer = setTimeout(() => save().catch(notify), 250); };
function save() {
    clearTimeout(saveTimer);
    if (!loggedIn)
        return Promise.resolve();
    const value = structuredClone(settings);
    updateMenuWarnings();
    savePromise = savePromise.catch(() => { }).then(() => api('/settings', 'PUT', value)).then(() => { void refreshTerminals(); });
    return savePromise;
}
function destroyWorkspace(value?: Mounted) {
    if (!value) return;
    warmWorkspaces.delete(value.ws.id);
    value.items.forEach(item => item.view.dispose());
    value.grid?.destroy(false);
    value.board.remove();
}
function finishSlide() {
    slide?.cancel(); slide = undefined;
    if (outgoing) {
        // Keep inactive DOM and terminal connections in the bounded cache.
        if (warmWorkspaces.has(outgoing.ws.id)) outgoing.board.remove();
        else destroyWorkspace(outgoing);
    }
    outgoing = undefined;
    if (mounted) mounted.board.style.left = '0';
}
function disposeViews() {
    cancelDrag(); chromeDisposers.splice(0).forEach(dispose => dispose());
    finishSlide();
    warmWorkspaces.forEach(destroyWorkspace); mounted = undefined;
}
function showLogin() {
    updates?.dispose(); updates = undefined;
    connection?.dispose(); connection = undefined;
    monitoring?.dispose(); monitoring = undefined;
    stopTerminalPolling();
    terminalSessions = []; terminalError = '';
    loggedIn = false;
    setCSRF('');
    clearTimeout(saveTimer);
    disposeViews();
    cancelTransfers();
    root.replaceChildren();
    document.documentElement.dataset.theme = 'dark';
    const page = el('div', 'login-page');
    const form = el('form', 'login-form');
    const logo = el('img', 'login-logo');
    logo.src = verticalLogo;
    logo.alt = 'Tuxee';
    logo.width = logo.height = 512;
    logo.draggable = false;
    form.append(logo);
    const username = el('input'), password = el('input');
    username.name = 'username';
    username.autocomplete = 'username';
    username.required = true;
    username.autofocus = matchMedia('(pointer: fine)').matches;
    password.name = 'password';
    password.type = 'password';
    password.autocomplete = 'current-password';
    password.required = true;
    for (const [text, input] of [['Username', username], ['Password', password]] as const) {
        const label = el('label', 'field', text);
        label.append(input);
        form.append(label);
    }
    const status = el('p', 'login-error');
    status.setAttribute('role', 'alert');
    const submit = button('Sign in');
    submit.type = 'submit';
    submit.className = 'primary login-submit';
    form.append(status, submit);
    form.onsubmit = async (e) => { e.preventDefault(); submit.disabled = true; status.textContent = ''; const value = password.value; password.value = ''; try {
        await api('/login', 'POST', { username: username.value, password: value });
        if (form.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
        await load();
    }
    catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Sign in failed';
    }
    finally {
        submit.disabled = false;
    } };
    page.append(form);
    root.append(page);
    if (username.autofocus) username.focus();
}
async function load() {
    const value = await api<{
        user: User;
        csrf: string;
        settings: Settings;
    }>('/me');
    user = value.user;
    settings = value.settings;
    setCSRF(value.csrf);
    loggedIn = true;
    connection?.dispose(); connection = new BackendConnection();
    monitoring?.dispose();
    monitoring = new Monitoring(settings.monitoring, async preferences => {
        const previous = settings.monitoring;
        settings.monitoring = preferences;
        try { await save(); } catch (error) { settings.monitoring = previous; throw error; }
    });
    if (!settings.workspaces.length) {
        const ws = newWorkspace('Workspace 1', user.home);
        settings.workspaces = [ws];
        settings.current = ws.id;
        await save();
    }
    render();
    updates?.dispose(); updates = new Updates(updateMenuWarnings);
    void refreshTerminals();
    prepareDownloads();
}
function isCompact() { return innerWidth < 760 || innerHeight < 480; }
function render(direction = 0) {
    document.documentElement.dataset.theme = settings.theme;
    const ws = current();
    if (!root.querySelector('.workspace-viewport')) {
        root.replaceChildren();
        viewportRoot = el('main', 'workspace-viewport');
        viewportRoot.setAttribute('aria-label', 'Workspace');
        track = el('div', 'workspace-track');
        viewportRoot.append(track); root.append(viewportRoot);
    }
    if (!mounted || mounted.ws.id !== ws.id) {
        finishSlide();
        outgoing = mounted;
        mounted = warmWorkspaces.get(ws.id);
        if (!mounted) {
            if (warmWorkspaces.size >= MAX_WARM_WORKSPACES) {
                const oldest = warmWorkspaces.values().next().value!;
                if (outgoing === oldest) outgoing = undefined;
                destroyWorkspace(oldest);
            }
            mounted = { ws, board: el('section', 'board'), gridEl: el('div', 'grid-stack'), compact: isCompact(), items: new Map() };
            mounted.board.dataset.workspace = ws.id;
            mounted.board.append(mounted.gridEl);
            warmWorkspaces.set(ws.id, mounted);
        }
        mounted.board.inert = false;
        mounted.board.style.left = '0';
        track.append(mounted.board);
        if (outgoing && direction) mounted.board.style.left = `${direction * 100}%`;
        syncWorkspace(mounted);
        if (outgoing && direction && duration(220)) {
            outgoing.board.inert = true;
            slide = track.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-direction * 100}%)` }], { duration: duration(220), easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
            const active = slide;
            active.finished.then(() => { if (slide === active) finishSlide(); }).catch(() => {});
        } else finishSlide();
    } else syncWorkspace(mounted);
    renderChrome();
}
function renderChrome() {
    chromeDisposers.splice(0).forEach(dispose => dispose());
    root.querySelector('.topbar')?.remove();
    root.querySelector('.component-controls')?.remove();
    const ws = current(), compact = isCompact();
    root.classList.toggle('compact', compact);
    const top = el('header', 'topbar');
    const brand = el('img', 'brand');
    brand.src = settings.theme === 'light'
        ? (compact ? emblemLogoLight : horizontalLogoLight)
        : (compact ? emblemLogo : horizontalLogo);
    brand.alt = 'Tuxee';
    brand.width = compact ? 128 : 320;
    brand.height = compact ? 117 : 128;
    brand.draggable = false;
    const about = button('About Tuxee', undefined, openAbout, 'brand-button');
    about.setAttribute('aria-haspopup', 'dialog');
    about.replaceChildren(brand);
    top.append(about);
    const tabs = el('nav', 'workspace-tabs');
    tabs.setAttribute('aria-label', 'Workspaces');
    for (const item of settings.workspaces) {
        const group = el('div', 'workspace-tab-item');
        group.dataset.workspace = item.id;
        group.classList.toggle('active', item.id === ws.id);
        const tab = button(item.name, undefined, () => switchWorkspace(item.id), 'workspace-tab');
        tab.classList.toggle('active', item.id === ws.id);
        tab.setAttribute('aria-current', String(item.id === ws.id));
        tab.setAttribute('aria-haspopup', 'menu');
        if (!compact) tab.ondblclick = () => renameWorkspace(item).catch(notify);
        chromeDisposers.push(bindContextMenu(group, position => workspaceMenu(item, tab, position), compact));
        group.append(tab);
        if (!compact) {
            const menu = button('Workspace menu', 'ChevronDown', () => workspaceMenu(item, menu), 'workspace-menu');
            menu.setAttribute('aria-haspopup', 'menu'); group.append(menu);
        }
        tabs.append(group);
    }
    const tabItems = [...tabs.children] as HTMLElement[];
    tabs.replaceChildren();
    const workspaces = el('div', 'workspace-controls');
    workspaces.append(tabs, button('New workspace', 'Plus', createWorkspace));
    top.append(workspaces);
    const right = el('div', 'topbar-right'), additions = el('div', 'panel-additions');
    for (const [kind, label, name] of [['files', 'Add file browser', 'FolderPlus'], ['terminal', 'Add terminal', 'SquareTerminal']] as const) {
        const add = button(label, name, () => addPanel(kind), 'add-panel');
        add.onpointerdown = event => { if (!compact) beginDrag(event, kind); };
        additions.append(add);
    }
    if (!compact) {
        let collapseTimer: ReturnType<typeof setTimeout> | undefined;
        const collapseLater = () => {
            clearTimeout(collapseTimer);
            collapseTimer = setTimeout(() => arrange.classList.remove('expanded'), 2000);
        };
        const arrange = button('Rearrange workspace', 'LayoutPanelTop', () => {
            cycleLayout(ws, mounted!.gridEl.clientWidth, mounted!.gridEl.clientHeight);
            changed(); syncWorkspace(mounted!); updateLayoutButton(true);
            clearTimeout(collapseTimer);
            arrange.classList.add('expanded');
            if (!arrange.matches(':hover')) collapseLater();
        }, 'layout-cycle');
        arrange.removeAttribute('title');
        const label = el('span', 'layout-label');
        label.setAttribute('aria-hidden', 'true'); arrange.append(label);
        arrange.onpointerenter = () => clearTimeout(collapseTimer);
        arrange.onpointerleave = collapseLater;
        chromeDisposers.push(() => clearTimeout(collapseTimer));
        additions.append(arrange);
    }
    if (!compact) right.append(additions);
    if (!compact && monitoring) {
        const monitor = el('div', 'monitor-controls');
        monitor.append(monitoring.summary()); right.append(monitor);
    }
    right.append(button('Toggle light or dark theme', settings.theme === 'dark' ? 'Sun' : 'Moon', () => {
        settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = settings.theme; changed(); renderChrome();
    }, 'theme-toggle'));
    const account = button('User menu', undefined, () => userMenu(account), 'user-menu-button');
    account.replaceChildren(el('span', 'username', user.name), icon('Menu'));
    account.setAttribute('aria-haspopup', 'menu');
    setMenuWarning(account, accountActions().flatMap(action => action[3] ? [action[3]] : []).join('\n'));
    right.append(account); top.append(right);
    const componentTabs = el('nav', 'component-tabs');
    componentTabs.setAttribute('aria-label', 'Components');
    const componentControls = el('div', 'component-controls');
    componentControls.append(componentTabs);
    if (compact) componentControls.append(additions);
    const components: HTMLElement[] = [];
    for (const panel of ws.panels) {
        const item = mounted!.items.get(panel.id)!;
        const group = el('div', 'component-tab-item'); group.classList.toggle('active', panel.id === ws.active);
        const tab = button(item.title.textContent || panel.kind, undefined, () => activatePanel(panel), 'component-tab');
        tab.replaceChildren(icon(panel.kind === 'files' ? 'Folder' : 'SquareTerminal'), el('span', 'component-tab-title', item.title.textContent || panel.kind));
        tab.dataset.componentName = panel.id;
        tab.classList.toggle('active', panel.id === ws.active); group.append(tab);
        tab.setAttribute('aria-haspopup', 'menu');
        chromeDisposers.push(bindContextMenu(tab, position => componentMenu(panel, tab, position), compact));
        components.push(group);
    }
    root.prepend(top, componentControls);
    updateLayoutButton();
    chromeDisposers.push(overflowTabs(tabs, tabItems, 'More workspaces', compact ? undefined : items => {
        settings.workspaces = items.map(item => settings.workspaces.find(ws => ws.id === item.dataset.workspace)!);
        changed();
    }));
    if (compact) chromeDisposers.push(overflowTabs(componentTabs, components, 'More components'));
    mounted?.grid?.cellHeight(cellHeight(mounted));
    mounted?.items.forEach(item => item.view.resize?.());
}
function cellHeight(value: Mounted) { return Math.max(140, value.gridEl.clientHeight / value.ws.rows); }
function syncWorkspace(value: Mounted, previousRects?: Map<string, DOMRect>) {
    const { ws, board, gridEl, items } = value;
    const before = previousRects || new Map([...items].map(([id, item]) => [id, item.node.getBoundingClientRect()]));
    const compact = isCompact();
    if (compact !== value.compact) { value.grid?.destroy(false); value.grid = undefined; value.compact = compact; }
    board.classList.toggle('compact-board', compact);
    if (!ws.panels.some(p => p.id === ws.active)) ws.active = ws.panels[0]?.id || '';
    for (const [id, item] of items) if (!ws.panels.some(p => p.id === id)) {
        value.grid?.removeWidget(item.node, false, false); item.view.dispose(); item.node.remove(); items.delete(id);
    }
    for (const panel of ws.panels) {
        let item = items.get(panel.id);
        if (!item) {
            const node = el('section', 'grid-stack-item'); node.dataset.panel = panel.id;
            const content = el('div', 'grid-stack-item-content panel'), head = el('header', 'panel-header');
            const title = el('span', 'panel-title', panel.name || (panel.kind === 'files' ? 'Files' : 'Terminal'));
            const tools = el('div', 'panel-tools');
            tools.append(button(panel.kind === 'terminal' ? 'Rename terminal' : 'Rename file browser', 'Pencil', () => items.get(panel.id)?.view.renamePanel()));
            tools.append(button('Close panel', 'X', () => closePanel(panel)));
            head.append(icon(panel.kind === 'files' ? 'Folder' : 'SquareTerminal'), title, tools);
            head.ondblclick = event => { if (!(event.target as Element).closest('button')) { const before = ws.panels.map(p => ({ ...p })); Object.assign(panel, expandPanel(ws, panel)); layoutChanged(ws, before); syncWorkspace(value); } };
            head.onpointerdown = event => {
                if (!value.compact && !(event.target as Element).closest('button')) beginDrag(event, panel.kind, panel);
            };
            scopeNotifications(tools, content);
            tools.onpointerdown = event => event.stopPropagation();
            const body = el('div', 'panel-body');
            content.append(head, body); node.append(content); gridEl.append(node);
            const hooks = { user, changed, close: () => closePanel(panel), openTerminal: (path: string) => addPanel('terminal', path), title: (name: string) => { title.textContent = name; const tab = document.querySelector<HTMLButtonElement>(`[data-component-name="${panel.id}"]`); if (tab) { tab.querySelector('.component-tab-title')!.textContent = name; tab.title = name; tab.setAttribute('aria-label', name); window.dispatchEvent(new Event('tuxee-tabs-changed')); } } };
            const view = panel.kind === 'files' ? new FileView(body, panel, hooks) : new TerminalView(body, panel, hooks);
            item = { node, view, tools, title }; items.set(panel.id, item);
        }
        item.node.hidden = compact && panel.id !== ws.active;
        for (const key of ['x', 'y', 'w', 'h'] as const) item.node.setAttribute(`gs-${key}`, String(panel[key]));
        item.node.setAttribute('gs-id', panel.id);
    }
    if (!compact) {
        if (!value.grid) {
            value.grid = GridStack.init({ column: ws.columns, maxRow: ws.rows, cellHeight: cellHeight(value), margin: 5, float: true, disableDrag: true, resizable: { handles: 'e, s, w, se, sw' }, animate: false }, gridEl);
            let resizeRects: Map<string, DOMRect> | undefined;
            value.grid.on('resizestart', (_event, node) => {
                board.classList.add('resizing-panel');
                // Grid resize events skip pixels within a cell; the drag driver reports every live rectangle.
                GridStack.getDD().on(node, 'resize', () => { resizeRects = new Map([...items].map(([id, item]) => [id, item.node.getBoundingClientRect()])); });
            });
            value.grid.on('resizestop', () => {
                board.classList.remove('resizing-panel');
                const next = ws.panels.map(panel => {
                    const node = value.grid!.engine.nodes.find(n => n.id === panel.id)!;
                    return { ...panel, x: node.x!, y: node.y!, w: node.w!, h: node.h! };
                });
                if (validGrid({ ...ws, panels: next })) {
                    const before = ws.panels.map(p => ({ ...p }));
                    next.forEach(rect => Object.assign(ws.panels.find(p => p.id === rect.id)!, rect)); layoutChanged(ws, before);
                }
                syncWorkspace(value, resizeRects); resizeRects = undefined;
            });
        } else {
            value.grid.load(ws.panels.map(panel => ({ ...panel, minW: 1, minH: 1, noMove: true })), false);
            for (const panel of ws.panels) {
                const node = items.get(panel.id)!.node;
                if (!value.grid.engine.nodes.some(n => n.el === node)) value.grid.makeWidget(node, { ...panel, minW: 1, minH: 1, noMove: true });
            }
        }
        value.grid.cellHeight(cellHeight(value));
    }
    renderVacancies(value);
    renderDividers(value);
    for (const [id, item] of items) {
        const previous = before.get(id), next = item.node.getBoundingClientRect();
        if (!compact && previous?.width && previous.height && next.width && next.height && (previous.x !== next.x || previous.y !== next.y || previous.width !== next.width || previous.height !== next.height))
            animateGeometry(item.node, previous, next);
        item.view.resize?.();
    }
}
function renderDividers(value: Mounted) {
    const { ws, gridEl } = value;
    const focused = (document.activeElement as HTMLElement)?.dataset.divider;
    gridEl.querySelectorAll('.workspace-divider').forEach(node => node.remove());
    if (value.compact) return;
    const dividers = sharedDividers(ws);
    function handle(axes: Divider[], x: number, y: number, w: number, h: number, junction = false) {
        const movable = axes.filter(d => d.min < d.max);
        if (!movable.length) return;
        const node = el('div', 'workspace-divider');
        node.dataset.divider = axes.map(d => `${d.axis}:${d.before.join(',')}:${d.after.join(',')}`).join('/');
        node.dataset.axis = movable.length === 2 ? 'both' : movable[0].axis;
        node.classList.toggle('divider-junction', junction);
        node.tabIndex = 0;
        node.setAttribute('role', junction ? 'button' : 'separator');
        node.setAttribute('aria-label', junction ? 'Resize adjoining panels' : 'Resize panels');
        if (!junction) {
            const d = movable[0];
            node.setAttribute('aria-orientation', d.axis === 'x' ? 'vertical' : 'horizontal');
            node.setAttribute('aria-valuemin', String(d.min));
            node.setAttribute('aria-valuemax', String(d.max));
            node.setAttribute('aria-valuenow', String(d.at));
        }
        Object.assign(node.style, { left: `${100 * x / ws.columns}%`, top: `${100 * y / ws.rows}%`, width: w ? `${100 * w / ws.columns}%` : junction ? '14px' : '10px', height: h ? `${100 * h / ws.rows}%` : junction ? '14px' : '10px', transform: `translate(${w ? '0' : '-50%'}, ${h ? '0' : '-50%'})` });
        node.onpointerdown = event => beginDividerResize(value, movable, event);
        node.onkeydown = event => {
            const dx = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            const dy = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
            if ((!dx && !dy) || dragging) return;
            event.preventDefault();
            const before = ws.panels.map(p => ({ ...p })), next = resizeDividers(ws, movable, dx, dy);
            if (next && validGrid({ ...ws, panels: next })) {
                next.forEach(p => Object.assign(ws.panels.find(old => old.id === p.id)!, p));
                layoutChanged(ws, before); syncWorkspace(value);
            }
        };
        gridEl.append(node);
        if (focused === node.dataset.divider) node.focus({ preventScroll: true });
    }
    for (const d of dividers)
        handle([d], d.axis === 'x' ? d.at : d.from, d.axis === 'x' ? d.from : d.at, d.axis === 'x' ? 0 : d.to - d.from, d.axis === 'x' ? d.to - d.from : 0);
    for (const x of dividers.filter(d => d.axis === 'x')) for (const y of dividers.filter(d => d.axis === 'y'))
        if (x.at >= y.from && x.at <= y.to && y.at >= x.from && y.at <= x.to)
            handle([x, y], x.at, y.at, 0, 0, true);
}
function beginDividerResize(value: Mounted, dividers: Divider[], event: PointerEvent) {
    if (event.button !== 0 || dragging || value.compact) return;
    event.preventDefault(); event.stopPropagation(); cancelDrag(); finishSlide();
    const trigger = event.currentTarget as HTMLElement, { ws, gridEl, items } = value;
    const snapshot = { ...ws, panels: ws.panels.map(p => ({ ...p })) };
    const cellW = gridEl.clientWidth / ws.columns, cellH = cellHeight(value);
    const affected = new Set(dividers.flatMap(d => [...d.before, ...d.after]));
    const events = new AbortController();
    let dx = 0, dy = 0;
    items.forEach(item => item.node.getAnimations().forEach(animation => animation.cancel()));
    trigger.setPointerCapture(event.pointerId);
    trigger.classList.add('divider-active');
    dragging = true; value.board.classList.add('resizing-dividers');
    const cursor = document.body.style.cursor;
    document.body.style.cursor = dividers.length === 2 ? 'move' : dividers[0].axis === 'x' ? 'ew-resize' : 'ns-resize';
    function finish(cancelled = false) {
        const released = new Map([...items].map(([id, item]) => [id, item.node.getBoundingClientRect()]));
        events.abort(); cancelDrag = () => {};
        if (trigger.hasPointerCapture(event.pointerId)) trigger.releasePointerCapture(event.pointerId);
        if (document.activeElement === trigger) trigger.blur();
        trigger.classList.remove('divider-active');
        dragging = false; value.board.classList.remove('resizing-dividers'); document.body.style.cursor = cursor;
        if (!cancelled) {
            const next = resizeDividers(snapshot, dividers, Math.round(dx), Math.round(dy));
            if (next && validGrid({ ...ws, panels: next })) {
                next.forEach(p => Object.assign(ws.panels.find(old => old.id === p.id)!, p));
                layoutChanged(ws, snapshot.panels);
            }
        }
        for (const id of affected) {
            const style = items.get(id)!.node.style;
            for (const property of ['left', 'top', 'width', 'height']) style.removeProperty(property);
        }
        syncWorkspace(value, released);
    }
    cancelDrag = () => finish(true);
    trigger.addEventListener('pointermove', move => {
        const x = (move.clientX - event.clientX) / cellW, y = (move.clientY - event.clientY) / cellH;
        const next = resizeDividers(snapshot, dividers, x, y);
        if (!next) return;
        dx = x; dy = y;
        for (const divider of dividers) {
            const panel = next.find(p => p.id === divider.after[0])!;
            trigger.style[divider.axis === 'x' ? 'left' : 'top'] = `${panel[divider.axis] * (divider.axis === 'x' ? cellW : cellH)}px`;
        }
        for (const p of next) if (affected.has(p.id)) {
            const item = items.get(p.id)!;
            Object.assign(item.node.style, { left: `${p.x * cellW}px`, top: `${p.y * cellH}px`, width: `${p.w * cellW}px`, height: `${p.h * cellH}px` });
            item.view.resize?.();
        }
    }, { signal: events.signal });
    trigger.addEventListener('pointerup', () => finish(), { signal: events.signal });
    trigger.addEventListener('pointercancel', () => finish(true), { signal: events.signal });
    trigger.addEventListener('lostpointercapture', () => finish(true), { signal: events.signal });
    window.addEventListener('blur', () => finish(true), { signal: events.signal });
    window.addEventListener('resize', () => finish(true), { signal: events.signal });
    document.addEventListener('keydown', key => { if (key.key === 'Escape') { key.preventDefault(); finish(true); } }, { signal: events.signal });
}
function renderVacancies(value: Mounted, moving?: Panel) {
    const { ws, gridEl, compact } = value;
    gridEl.querySelectorAll('.grid-vacancy').forEach(node => node.remove());
    if (!compact) for (let y = 0; y < ws.rows; y++) for (let x = 0; x < ws.columns; x++) {
        if (ws.panels.some(p => p !== moving && x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)) continue;
        const cell = el('div', 'grid-vacancy'); cell.setAttribute('aria-hidden', 'true');
        Object.assign(cell.style, { left: `${x / ws.columns * 100}%`, top: `${y / ws.rows * 100}%`, width: `${100 / ws.columns}%`, height: `${100 / ws.rows}%` }); gridEl.append(cell);
    }
}
function animateGeometry(node: HTMLElement, from: DOMRect, to: DOMRect) {
    node.getAnimations().forEach(animation => animation.cancel());
    return node.animate([
        { transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)`, width: `${from.width}px`, height: `${from.height}px` },
        { transform: 'none', width: `${to.width}px`, height: `${to.height}px` }
    ], { duration: duration(180), easing: 'cubic-bezier(.2,.7,.2,1)' });
}
function beginDrag(event: PointerEvent, kind: Kind, existing?: Panel) {
    if (event.button !== 0 || dragging || !mounted || mounted.compact) return;
    cancelDrag(); finishSlide();
    const value = mounted, ws = value.ws, trigger = event.currentTarget as HTMLElement;
    const panel = existing || newPanel(kind, user.home);
    const node = existing ? value.items.get(existing.id)!.node : el('section', 'panel new-panel-drag');
    node.getAnimations().forEach(animation => animation.cancel());
    const origin = existing ? node.getBoundingClientRect() : new DOMRect(event.clientX, event.clientY, 180, 100);
    const startX = event.clientX, startY = event.clientY;
    let active = false, where: DropTarget | undefined;
    const events = new AbortController();
    trigger.setPointerCapture(event.pointerId);
    function finish(cancelled = false) {
        events.abort(); cancelDrag = () => {};
        if (trigger.hasPointerCapture(event.pointerId)) trigger.releasePointerCapture(event.pointerId);
        if (!active) return;
        const released = node.getBoundingClientRect();
        const stopClick = (click: Event) => { click.preventDefault(); click.stopImmediatePropagation(); };
        trigger.addEventListener('click', stopClick, { capture: true, once: true });
        setTimeout(() => trigger.removeEventListener('click', stopClick, true), 100);
        dragging = false; hidePreview(); value.board.classList.remove('docking');
        const before = ws.panels.map(p => ({ ...p }));
        let applied = false;
        if (!cancelled && where) {
            if ('layout' in where) { for (const next of where.layout) { const old = ws.panels.find(p => p.id === next.id); if (old) Object.assign(old, next); else ws.panels.push(Object.assign(panel, next)); } applied = true; }
            else if (where.edge === 'center' && existing) {
                const rect = { x: where.target.x, y: where.target.y, w: where.target.w, h: where.target.h };
                Object.assign(where.target, { x: panel.x, y: panel.y, w: panel.w, h: panel.h }); Object.assign(panel, rect); applied = true;
            } else if (where.edge !== 'center') applied = split(ws, where.target.id, panel, where.edge);
        }
        node.style.transform = ''; node.classList.remove('panel-dragging');
        if (!existing) node.remove();
        if (applied) { ws.active = panel.id; layoutChanged(ws, before); render(); }
        else renderVacancies(value);
        const settled = existing ? node : applied ? value.items.get(panel.id)?.node : undefined;
        if (settled) {
            settled.getAnimations().forEach(animation => animation.cancel());
            const destination = settled.getBoundingClientRect();
            settled.classList.add('panel-settling');
            const animation = animateGeometry(settled, released, destination);
            animation.finished.finally(() => settled.classList.remove('panel-settling')).catch(() => {});
        }
    }
    cancelDrag = () => finish(true);
    document.addEventListener('keydown', key => { if (key.key === 'Escape') { key.preventDefault(); finish(true); } }, { signal: events.signal });
    trigger.addEventListener('pointercancel', () => finish(true), { signal: events.signal });
    trigger.addEventListener('lostpointercapture', () => finish(true), { signal: events.signal });
    trigger.addEventListener('pointerup', () => finish(), { signal: events.signal });
    trigger.addEventListener('pointermove', move => {
        const dx = move.clientX - startX, dy = move.clientY - startY;
        if (!active && Math.hypot(dx, dy) < 5) return;
        move.preventDefault();
        if (!active) {
            active = dragging = true; value.board.classList.add('docking'); node.classList.add('panel-dragging');
            renderVacancies(value, existing);
            if (!existing) {
                node.append(icon(kind === 'files' ? 'Folder' : 'SquareTerminal'));
                Object.assign(node.style, { position: 'fixed', left: `${origin.x}px`, top: `${origin.y}px`, width: `${origin.width}px`, height: `${origin.height}px` });
                document.body.append(node);
            }
        }
        node.style.transform = `translate(${dx}px, ${dy}px)`;
        const grid = value.gridEl.getBoundingClientRect(), cellW = grid.width / ws.columns, cellH = grid.height / ws.rows;
        where = undefined;
        const snap = screenSnap(ws, move.clientX - grid.left, move.clientY - grid.top, grid.width, grid.height);
        if (snap) {
            const layout = snapLayout(ws, panel, snap);
            if (layout) where = { layout, rect: snap };
            showPreview(value.gridEl, { x: snap.x * cellW, y: snap.y * cellH, w: snap.w * cellW, h: snap.h * cellH }, 'snap', !layout);
            return;
        }
        const cx = move.clientX, cy = move.clientY;
        const rect = gridDrop(ws, cx - grid.left, cy - grid.top, grid.width, grid.height);
        // A target spanning occupied and vacant cells may trim its neighbors from either side of the gap.
        const covered = rect && ws.panels.filter(p => p !== existing).reduce((sum, p) => sum +
            Math.max(0, Math.min(p.x + p.w, rect.x + rect.w) - Math.max(p.x, rect.x)) *
            Math.max(0, Math.min(p.y + p.h, rect.y + rect.h) - Math.max(p.y, rect.y)), 0);
        if (rect && covered && covered < rect.w * rect.h) {
            const layout = dropLayout(ws, panel, rect);
            if (layout) where = { layout, rect };
            showPreview(value.gridEl, { x: rect.x * cellW, y: rect.y * cellH, w: rect.w * cellW, h: rect.h * cellH }, 'empty', !layout);
            return;
        }
        const target = ws.panels.find(p => p !== existing && cx >= grid.left + p.x * cellW && cx < grid.left + (p.x + p.w) * cellW && cy >= grid.top + p.y * cellH && cy < grid.top + (p.y + p.h) * cellH);
        if (target) {
            const tx = (cx - grid.left - target.x * cellW) / (target.w * cellW), ty = (cy - grid.top - target.y * cellH) / (target.h * cellH);
            const distances: [Edge, number][] = [['left', tx], ['right', 1 - tx], ['top', ty], ['bottom', 1 - ty]];
            distances.sort((a, b) => a[1] - b[1]);
            const edge = distances[0][1] < .28 ? distances[0][0] : 'center';
            if (edge === 'center' ? !!existing : (edge === 'left' || edge === 'right' ? target.w : target.h) >= 2) where = { target, edge };
            const container = value.items.get(target.id)!.node.querySelector<HTMLElement>('.panel')!, bounds = container.getBoundingClientRect();
            const rect = { x: bounds.left - grid.left + container.clientLeft, y: bounds.top - grid.top + container.clientTop, w: container.clientWidth, h: container.clientHeight };
            if (edge === 'left' || edge === 'right') { rect.w /= 2; if (edge === 'right') rect.x += rect.w; }
            if (edge === 'top' || edge === 'bottom') { rect.h /= 2; if (edge === 'bottom') rect.y += rect.h; }
            showPreview(value.gridEl, rect, edge, !where);
        } else {
            if (!rect) { hidePreview(); return; }
            const layout = dropLayout(ws, panel, rect);
            if (layout) where = { layout, rect };
            showPreview(value.gridEl, { x: rect.x * cellW, y: rect.y * cellH, w: rect.w * cellW, h: rect.h * cellH }, 'empty', !where);
        }
    }, { signal: events.signal });
}
function updateLayoutButton(advance = false) {
    const button = root.querySelector<HTMLButtonElement>('.layout-cycle');
    if (!button) return;
    const mode = current().layout?.mode || 0, names = ['Custom', 'Balanced', 'Terminals', 'Files'];
    const turn = advance ? Number(button.dataset.turn || 0) + 1 : mode;
    button.dataset.mode = String(mode); button.dataset.turn = String(turn);
    button.setAttribute('aria-description', `${names[mode]} → ${names[(mode + 1) % 4]}`);
    const label = button.querySelector<HTMLElement>('.layout-label')!;
    label.textContent = names[mode];
    button.querySelector('svg')!.style.transform = `rotate(${turn * 90}deg)`;
    button.disabled = !current().panels.length;
}
function layoutChanged(ws: Workspace, before?: Panel[]) {
    const unchanged = before && before.length === ws.panels.length && before.every(previous => {
        const panel = ws.panels.find(p => p.id === previous.id);
        return panel && panel.x === previous.x && panel.y === previous.y && panel.w === previous.w && panel.h === previous.h;
    });
    if (!unchanged) delete ws.layout;
    changed();
    if (ws === current()) updateLayoutButton();
}
function addPanel(kind: Kind, path = user.home, terminal?: TerminalInfo) {
    const ws = current(), panel = newPanel(kind, path);
    if (terminal) panel.terminal = terminal.id;
    if (!addCompact(ws, panel)) throw new Error('Workspace full');
    ws.active = panel.id; layoutChanged(ws); render();
}
function stopPanel(panel: Panel, value?: Mounted) {
    if (panel.kind !== 'terminal') return;
    const view = value?.items.get(panel.id)?.view;
    (view instanceof TerminalView ? view.close() : terminateTerminal(panel)).catch(notify).finally(() => refreshTerminals());
}
async function closePanel(panel: Panel) {
    const value = mounted, item = value?.items.get(panel.id);
    if (!value || !item || item.node.dataset.closing) return;
    if (item.view.canClose && !await item.view.canClose()) return;
    const width = value.gridEl.clientWidth;
    item.node.dataset.closing = 'true';
    const animation = item.node.animate([{ opacity: 1, transform: 'scale(1)', transformOrigin: 'center' }, { opacity: 0, transform: 'scale(.96)', transformOrigin: 'center' }], { duration: duration(160), fill: 'forwards' });
    try {
        stopPanel(panel, value);
        await animation.finished;
        value.ws.panels = value.ws.panels.filter(p => p.id !== panel.id);
        if (!value.compact) expandAfterClose(value.ws, panel, value.gridEl.clientWidth || width,
            value.ws.panels.filter(p => !value.items.get(p.id)?.node.dataset.closing));
        layoutChanged(value.ws);
        if (mounted === value) render();
    } catch (error) { animation.cancel(); delete item.node.dataset.closing; throw error; }
}
async function canLeave(value?: Mounted) { for (const item of value?.items.values() || []) if (item.view.canClose && !await item.view.canClose()) return false; return true; }
async function switchWorkspace(value: string, checked = false) {
    cancelDrag();
    if (settings.current === value) return;
    if (!checked && !warmWorkspaces.has(value) && warmWorkspaces.size >= MAX_WARM_WORKSPACES && !await canLeave(warmWorkspaces.values().next().value)) return;
    const from = settings.workspaces.findIndex(ws => ws.id === settings.current), to = settings.workspaces.findIndex(ws => ws.id === value);
    settings.current = value; changed(); render(to > from ? 1 : -1);
}
async function createWorkspace() {
    if (settings.workspaces.length >= 12) { notify('Workspace limit reached'); return; }
    if (warmWorkspaces.size >= MAX_WARM_WORKSPACES && !await canLeave(warmWorkspaces.values().next().value)) return;
    const ws = newWorkspace(`Workspace ${settings.workspaces.length + 1}`, user.home); settings.workspaces.push(ws); await switchWorkspace(ws.id, true);
}
async function renameWorkspace(ws: Workspace) {
    const name = await ask('Rename workspace', 'Name', ws.name);
    if (!name) return;
    if (name.length > 60) throw new Error('Name is too long');
    ws.name = name; changed(); renderChrome();
}
function workspaceMenu(ws: Workspace, tab: HTMLElement, position?: { x: number; y: number }) {
    tabMenu(tab, `${ws.name} workspace`, ws.id === settings.current, [
        ['Activate', 'ArrowRight', () => switchWorkspace(ws.id)],
        ['Rename', 'Pencil', () => renameWorkspace(ws)],
        ['Close', 'X', () => closeWorkspace(ws)],
    ], position);
}
function activatePanel(panel: Panel) { current().active = panel.id; changed(); render(); }
function componentMenu(panel: Panel, tab: HTMLElement, position?: { x: number; y: number }) {
    const item = mounted!.items.get(panel.id)!;
    const actions: TabAction[] = [
        ['Activate', 'ArrowRight', () => activatePanel(panel)],
        ['Rename', 'Pencil', () => item.view.renamePanel()],
        ['Close', 'X', () => closePanel(panel)],
    ];
    const control = item.tools.querySelector<HTMLButtonElement>('[aria-label="Take control"]');
    if (control && !control.hidden) actions.splice(1, 0, ['Take control', 'Hand', () => control.click()]);
    tabMenu(tab, item.title.textContent || panel.kind, panel.id === current().active, actions, position);
}
type TabAction = [string, Parameters<typeof icon>[0], () => unknown];
function tabMenu(tab: HTMLElement, title: string, active: boolean, actions: TabAction[], position?: { x: number; y: number }) {
    const content = el('div', 'menu-actions');
    content.setAttribute('aria-label', title);
    const item = mounted?.items.get(tab.dataset.componentName || '');
    if (item) scopeNotifications(content, item.node.querySelector<HTMLElement>('.panel')!);
    let close = () => {};
    for (const [label, name, action] of actions) {
        const control = button(label, name, () => { close(); return action(); });
        control.disabled = label === 'Activate' && active;
        control.append(el('span', '', label)); control.setAttribute('role', 'menuitem'); content.append(control);
    }
    const rect = tab.getBoundingClientRect();
    const host = tab.classList.contains('component-tab') ? '.component-tabs' : '.workspace-tabs';
    const returnFocus = tab.closest('.overflow-tabs') ? document.querySelector<HTMLElement>(`${host} .overflow-toggle`)! : tab;
    ({ close } = popover(position || { x: rect.left, y: rect.bottom }, content, returnFocus));
}
async function closeWorkspace(ws = current()) {
    const value = warmWorkspaces.get(ws.id);
    if (!await canLeave(value)) return;
    if (!await confirmAction(`Close ${ws.name}?`, 'Stop all terminals in this workspace?', 'Close workspace')) return;
    const index = settings.workspaces.indexOf(ws), active = settings.current === ws.id;
    ws.panels.forEach(panel => stopPanel(panel, value));
    settings.workspaces = settings.workspaces.filter(value => value.id !== ws.id);
    warmWorkspaces.delete(ws.id);
    if (value !== mounted && value !== outgoing) destroyWorkspace(value);
    if (!settings.workspaces.length) settings.workspaces.push(newWorkspace('Workspace 1', user.home));
    if (active) settings.current = settings.workspaces[Math.max(0, index - 1)].id;
    changed(); render(active ? (index ? -1 : 1) : 0);
}
function unlistedTerminals() {
    const listed = new Set(settings.workspaces.flatMap(ws => ws.panels.filter(panel => panel.kind === 'terminal').map(panel => panel.terminal)));
    return terminalSessions.filter(info => !listed.has(info.id));
}
function stopTerminalPolling() {
    clearTimeout(terminalTimer); terminalRequest?.abort();
}
async function refreshTerminals() {
    stopTerminalPolling();
    if (!loggedIn || document.hidden) return false;
    const request = terminalRequest = new AbortController();
    try {
        const sessions = await api<TerminalInfo[]>('/terminals', 'GET', undefined, request.signal);
        if (request.signal.aborted) return false;
        terminalSessions = sessions; terminalError = '';
    } catch (error) {
        if (request.signal.aborted) return false;
        terminalError = error instanceof Error ? error.message : 'Unable to check retained terminals';
    }
    updateMenuWarnings();
    terminalTimer = setTimeout(() => refreshTerminals(), 10000);
    return !terminalError;
}
function accountActions(): [...TabAction, string?][] {
    const count = unlistedTerminals().filter(info => !info.exited).length;
    const actions: [...TabAction, string?][] = [
        ['Settings', 'Settings', openSettings],
        ['Retained terminals', 'SquareTerminal', retainedTerminals, terminalError || (count ? `${count} running terminal${count === 1 ? '' : 's'} outside your workspaces` : '')],
        ['About', 'Info', openAbout, updates?.warning], ['Log out', 'LogOut', logout]
    ];
    if (monitoring) actions.unshift(['Resource monitor', 'Activity', () => monitoring?.open()]);
    return actions;
}
function setMenuWarning(control: HTMLElement, warning: string) {
    control.querySelector('.menu-warning')?.remove();
    control.removeAttribute('aria-description');
    control.title = control.getAttribute('aria-label') || '';
    if (!warning) return;
    const badge = el('span', 'menu-warning');
    badge.append(icon('TriangleAlert')); badge.setAttribute('aria-hidden', 'true');
    control.append(badge);
    control.setAttribute('aria-description', warning); control.title += `: ${warning}`;
}
function updateMenuWarnings() {
    if (!loggedIn) return;
    const actions = accountActions(), account = root.querySelector<HTMLElement>('.user-menu-button');
    if (account) setMenuWarning(account, actions.flatMap(action => action[3] ? [action[3]] : []).join('\n'));
    for (const [label, , , warning] of actions) {
        const control = document.querySelector<HTMLElement>(`.account-menu [aria-label="${label}"]`);
        if (control) setMenuWarning(control, warning || '');
    }
}
function userMenu(anchor: HTMLElement) {
    const content = el('div', 'menu-actions');
    content.classList.add('account-menu');
    const account = el('div', 'menu-username');
    account.append(icon('UserRound'), el('span', '', user.name));
    content.append(account);
    let close = () => {};
    for (const [label, name, action, warning] of accountActions()) {
        const b = button(label, name, () => { close(); return action(); });
        b.append(el('span', '', label)); b.setAttribute('role', 'menuitem'); content.append(b);
        setMenuWarning(b, warning || '');
    }
    ({ close } = popover(anchor, content));
    void refreshTerminals();
}
async function openAbout() {
    const content = el('div', 'about-content'), logo = el('img', 'about-logo');
    logo.src = settings.theme === 'light' ? verticalLogoLight : verticalLogo;
    logo.alt = 'Tuxee';
    logo.width = logo.height = 192; logo.draggable = false;
    const status = el('p', 'muted', 'Loading…');
    status.setAttribute('role', 'status');
    content.append(logo, el('p', 'about-tagline muted', 'Tuxee - the most convenient linux for servers and agents.'), status);
    const { dialog } = modal('About Tuxee', content);
    dialog.classList.add('about-modal');
    dialog.querySelector('h2')!.remove();
    const controller = new AbortController();
    dialog.addEventListener('close', () => controller.abort(), { once: true });
    if (updates) content.append(updates.view(controller.signal));
    try {
        const info = await api<{ version: string; os: string; kernel: string; architecture: string; hostname: string; username: string; uid: number; home: string; shell: string }>('/system', 'GET', undefined, controller.signal);
        const table = el('table', 'about-details'), body = el('tbody');
        table.setAttribute('aria-label', 'System information');
        for (const [label, value] of [
            ['Tuxee version', info.version], ['Operating system', info.os], ['Kernel', info.kernel],
            ['Architecture', info.architecture], ['Server name', info.hostname],
            ['User', `${info.username} (UID ${info.uid})`], ['Home directory', info.home], ['Shell', info.shell],
        ]) {
            const row = el('tr'), heading = el('th', '', label);
            heading.scope = 'row';
            row.append(heading, el('td', '', value || 'Unavailable')); body.append(row);
        }
        table.append(body); status.replaceWith(table);
    } catch (error) {
        if (!controller.signal.aborted) {
            status.setAttribute('role', 'alert');
            status.textContent = error instanceof Error ? error.message : 'System information is unavailable';
        }
    }
}
async function retainedTerminals() {
    if (!await refreshTerminals()) throw new Error(terminalError || 'Unable to check retained terminals');
    const content = el('div', 'retained-list');
    const { close } = modal('Retained terminals', content);
    const paint = () => {
        content.replaceChildren();
        const sessions = unlistedTerminals();
        if (!sessions.length) content.append(el('p', 'muted', 'No retained terminals.'));
        for (const info of sessions) {
            const row = el('div', 'retained-row'), text = el('div');
            text.append(el('strong', '', info.name), el('small', 'muted', `PID ${info.pid} · ${info.exited ? 'Ended' : info.attached ? 'Attached' : 'Detached'} · ${info.directory}`));
            row.append(text, button('Attach', undefined, () => { addPanel('terminal', info.directory, info); updateMenuWarnings(); close(); }), button('Terminate', 'Trash2', async () => { if (await confirmAction('Terminate terminal?', `Stop ${info.name} and its running work?`, 'Terminate')) {
                await api(`/terminals/${info.id}`, 'DELETE');
                terminalSessions = terminalSessions.filter(value => value.id !== info.id);
                updateMenuWarnings(); paint(); void refreshTerminals();
            } }));
            content.append(row);
        }
    };
    paint();
}
async function openSettings() {
    const content = el('div', 'form');
    const tls = await api('/tls');
    const details = el('section', 'tls-status');
    details.append(el('h3', '', 'Connection'), el('p', '', tls.source === 'public' ? `Public certificate · expires ${new Date(tls.expires).toLocaleString()}` : tls.source === 'local' ? 'Encrypted with a local certificate' : 'Plain HTTP'));
    if (tls.source === 'local') {
        const link = el('a', 'text-link', 'Download local CA certificate');
        link.href = '/api/tls/ca';
        link.download = 'tuxee-local-ca.crt';
        details.append(link);
    }
    if (tls.error)
        details.append(el('p', 'muted', tls.error));
    content.append(details);
    modal('Settings', content);
}
async function logout() {
    for (const value of warmWorkspaces.values()) if (!await canLeave(value)) return;
    await save(); await api('/logout', 'POST', {}); showLogin();
}
let resizeTimer: ReturnType<typeof setTimeout>;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (loggedIn && !dragging) render(); }, 100);
});
function viewport() {
    // Keyboard shrink affects layout; intentional pinch zoom must not resize the workspace.
    const height = visualViewport ? visualViewport.height * visualViewport.scale : innerHeight;
    document.documentElement.style.setProperty('--viewport-height', `${height}px`);
}
window.addEventListener('resize', viewport);
visualViewport?.addEventListener('resize', viewport);
viewport();
window.addEventListener('tuxee-unauthorized', () => { if (loggedIn) {
    showLogin();
    notify('Your session ended. Sign in to reconnect.');
} });
document.addEventListener('visibilitychange', () => { void refreshTerminals(); });
window.addEventListener('focus', () => { void refreshTerminals(); });
window.addEventListener('pagehide', () => { updates?.dispose(); connection?.dispose(); stopTerminalPolling(); monitoring?.dispose(); disposeViews(); cancelTransfers(); });
load().catch(() => showLogin());
