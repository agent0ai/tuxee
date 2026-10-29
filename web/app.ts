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
import { api, APIError, ask, bindContextMenu, button, confirmAction, el, icon, modal, notify, popover, scopeNotifications, setCSRF } from './ui';
import { id, directoryPath, addCompact, gridDrop, dropLayout, sharedDividers, resizeDividers, type Divider, newPanel, newWorkspace, orientWorkspace, split, validGrid, type Edge, type Kind, type Panel, type Settings, type User, type View, type Workspace, type TerminalInfo, screenSnap, snapLayout, cycleLayout, expandPanel, expandAfterClose, type Rect } from './model';
import { overflowTabs } from './overflow';
import { FileView } from './files';
import { clearFileCut } from './file-clipboard';
import { TerminalView, terminateTerminal, TERMINAL_FONT } from './term';
import { terminalTheme } from './terminal/state';
import { cancelTransfers, prepareDownloads, setUploadConcurrency } from './transfers';
import { Monitoring } from './monitor';
import { audio, audioControl, toggleMute, adjustVolume } from './audio';
import { installShortcuts, openShortcuts } from './shortcuts';
import { BackendConnection } from './connection';
import { Updates } from './updates';
import { setFaviconColor } from './favicon';
import { locale, t, errorText, translations, setTranslations, rememberLanguage, type Translations } from './i18n';
import { preventFileNavigation } from './file-drag';
preventFileNavigation();
const root = document.querySelector<HTMLElement>('#app')!;
const boot = root.querySelector<HTMLElement>('.boot');
if (boot) {
    const image = new Image();
    image.src = verticalLogo;
    void image.decode().then(() => boot.classList.add('ready')).catch(() => {});
}
const hostname = document.querySelector<HTMLMetaElement>('meta[name="tuxee-hostname"]')!.content;
let user: User, settings: Settings;
let loggedIn = false, loggingOut = false, saveTimer: ReturnType<typeof setTimeout> | undefined, savePromise = Promise.resolve();
let monitoring: Monitoring | undefined;
let connection: BackendConnection | undefined;
let updates: Updates | undefined;
let terminalSessions: TerminalInfo[] = [], terminalError = '';
let terminalRequest: AbortController | undefined, terminalTimer: ReturnType<typeof setTimeout> | undefined;
let terminalRefresh = Promise.resolve(true);
type Mounted = { ws: Workspace; board: HTMLElement; gridEl: HTMLElement; grid?: GridStack; compact: boolean; items: Map<string, { owner: Mounted; node: HTMLElement; view: View; tools: HTMLElement; title: HTMLElement }> };
let mounted: Mounted | undefined, outgoing: Mounted | undefined, slide: Animation | undefined;
const warmWorkspaces = new Map<string, Mounted>();
const MAX_WARM_WORKSPACES = 8;
let track: HTMLElement, viewportRoot: HTMLElement;
let dragging = false, cancelDrag = () => {};
let chromeDisposers: (() => void)[] = [];
let workspaceTabs: HTMLElement[] = [];
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
const defaultDirectory = (ws?: Workspace) => directoryPath(ws?.defaultDirectory || settings.defaultDirectory, user.home);
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
async function setEditorLineWrap(enabled: boolean) {
    const previous = settings.editorLineWrap;
    settings.editorLineWrap = enabled;
    try { await save(); }
    catch (error) { settings.editorLineWrap = previous; throw error; }
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
function updateTitle() {
    document.title = t("app.title", { name: loggedIn && settings.serverName || hostname });
}
function setColorMarker(color?: string) {
    if (loggedIn && color) document.documentElement.style.setProperty('--server-marker-border', `0.25rem solid ${color}`);
    else document.documentElement.style.removeProperty('--server-marker-border');
    setFaviconColor(loggedIn ? color : undefined);
}
function showLogin() {
    clearFileCut();
    audio.available(false);
    updates?.dispose(); updates = undefined;
    monitoring?.dispose(); monitoring = undefined;
    stopTerminalPolling();
    terminalSessions = []; terminalError = '';
    loggedIn = false;
    updateTitle();
    setColorMarker();
    setCSRF('');
    clearTimeout(saveTimer);
    disposeViews();
    cancelTransfers();
    setUploadConcurrency();
    root.replaceChildren();
    document.documentElement.dataset.theme = 'dark';
    const page = el('div', 'login-page');
    const content = el('div', 'login-content');
    const form = el('form', 'login-form');
    const logo = el('img', 'login-logo');
    logo.src = verticalLogo;
    logo.alt = t("app.tuxee");
    logo.width = logo.height = 512;
    logo.draggable = false;
    form.append(logo);
    const language = el('select', 'login-language');
    language.name = 'language';
    for (const item of translations().languages) {
        const option = el('option', '', `${item.code.toUpperCase()} ${item.name}`); option.value = item.code; language.append(option);
    }
    language.value = translations().language;
    form.append(language);
    const username = el('input'), password = el('input');
    username.name = 'username';
    username.autocomplete = 'username';
    username.required = true;
    username.autofocus = matchMedia('(pointer: fine)').matches;
    password.name = 'password';
    password.type = 'password';
    password.autocomplete = 'current-password';
    password.required = true;
    const loginLabels: { label: HTMLLabelElement; key: string }[] = [];
    for (const [key, input] of [['login.username', username], ['login.password', password]] as const) {
        const label = el('label', 'field', t(key));
        loginLabels.push({ label, key });
        label.append(input);
        form.append(label);
    }
    const status = el('p', 'login-error');
    status.setAttribute('role', 'alert');
    const submit = button(t("app.signIn"));
    submit.type = 'submit';
    submit.className = 'primary login-submit';
    form.append(status, submit);
    form.onsubmit = async (e) => { e.preventDefault(); submit.disabled = true; status.textContent = ''; const value = password.value; password.value = ''; try {
        await api('/login', 'POST', { username: username.value, password: value, language: translations().language });
        if (form.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
        await load();
    }
    catch (error) {
        status.textContent = error instanceof Error ? errorText(error) : t("app.signInFailed");
    }
    finally {
        submit.disabled = false;
    } };
    const version = document.querySelector<HTMLMetaElement>('meta[name="tuxee-version"]')!.content;
    const metadata = el('p', 'login-metadata', t('login.server', { hostname }));
    const github = el('a', '', t("app.version", { version }));
    github.dir = 'ltr'; github.href = 'https://github.com/agent0ai/tuxee'; github.target = '_blank'; github.rel = 'noopener noreferrer';
    metadata.append(github);
    const translateLogin = () => {
        document.documentElement.lang = translations().language;
        language.setAttribute('aria-label', t('login.language'));
        logo.alt = t('app.tuxee'); github.textContent = t('app.version', { version }); updateTitle();
        for (const {label, key} of loginLabels) label.firstChild!.textContent = t(key);
        submit.textContent = submit.title = t('login.signIn'); submit.setAttribute('aria-label', submit.title);
        metadata.firstChild!.textContent = t('login.server', { hostname });
    };
    translateLogin();
    language.onchange = async () => {
        const previous = translations().language;
        language.disabled = submit.disabled = true;
        try {
            const value = await api<Translations>(`/language?language=${encodeURIComponent(language.value)}`);
            if (!form.isConnected || loggedIn) return;
            setTranslations(value); rememberLanguage(); language.value = value.language;
            status.textContent = ''; translateLogin();
        } catch (error) { language.value = previous; status.textContent = error instanceof Error ? errorText(error) : t('login.languageFailed'); }
        finally { language.disabled = submit.disabled = false; }
    };
    content.append(form, metadata);
    page.append(content);
    root.append(page);
    if (username.autofocus) username.focus();
}
async function load(signal?: AbortSignal) {
    const value = await api<{
        user: User;
        csrf: string;
        settings: Settings;
        audio: boolean;
        i18n: Translations;
    }>('/me', 'GET', undefined, signal);
    if (signal?.aborted) return;
    if (value.i18n) setTranslations(value.i18n);
    user = value.user;
    settings = value.settings;
    setUploadConcurrency(settings.uploadConcurrency);
    setCSRF(value.csrf);
    loggedIn = true;
    audio.available(value.audio);
    updateTitle();
    setColorMarker(settings.serverColor);
    monitoring?.dispose();
    monitoring = new Monitoring(settings.monitoring, async preferences => {
        const previous = settings.monitoring;
        settings.monitoring = preferences;
        try { await save(); } catch (error) { settings.monitoring = previous; throw error; }
    });
    if (!settings.workspaces.length) {
        const ws = newWorkspace(t('app.workspaceNumber', { count: 1 }), defaultDirectory());
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
function mountWorkspace(ws: Workspace): Mounted {
    const value: Mounted = { ws, board: el('section', 'board'), gridEl: el('div', 'grid-stack'), compact: isCompact(), items: new Map() };
    value.board.dataset.workspace = ws.id;
    value.board.append(value.gridEl);
    value.board.oncontextmenu = event => {
        if (value.compact || dragging || event.defaultPrevented || (event.target as Element).closest('.panel')) return;
        event.preventDefault(); event.stopPropagation();
        const rect = value.gridEl.getBoundingClientRect();
        const near = { x: (event.clientX - rect.x) / rect.width * ws.columns, y: (event.clientY - rect.y) / rect.height * ws.rows };
        const content = el('div', 'menu-actions');
        let close = () => {};
        for (const [kind, label, name] of [['terminal', t("app.addTerminal"), 'SquareTerminal'], ['files', t("app.addFileBrowser"), 'FolderPlus']] as const) {
            const control = button(label, name, () => { close(); addPanel(kind, defaultDirectory(ws), undefined, near); });
            control.append(el('span', '', label)); control.setAttribute('role', 'menuitem');
            control.disabled = ws.panels.length >= 8; content.append(control);
        }
        ({ close } = popover({ x: event.clientX, y: event.clientY }, content));
    };
    warmWorkspaces.set(ws.id, value);
    return value;
}
function render(direction = 0) {
    document.documentElement.dataset.theme = settings.theme;
    const ws = current();
    if (!root.querySelector('.workspace-viewport')) {
        root.replaceChildren();
        viewportRoot = el('main', 'workspace-viewport');
        viewportRoot.setAttribute('aria-label', t("app.workspace"));
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
            mounted = mountWorkspace(ws);
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
    brand.alt = t("app.tuxee");
    brand.width = compact ? 128 : 320;
    brand.height = compact ? 117 : 128;
    brand.draggable = false;
    const about = button(t("app.aboutTuxee"), undefined, openAbout, 'brand-button');
    about.setAttribute('aria-haspopup', 'dialog');
    about.replaceChildren(brand);
    top.append(about);
    const tabs = el('nav', 'workspace-tabs');
    tabs.setAttribute('aria-label', t("app.workspaces"));
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
        const menu = button(t("app.workspaceMenu"), 'ChevronDown', () => workspaceMenu(item, menu), 'workspace-menu');
        menu.setAttribute('aria-haspopup', 'menu'); group.append(menu);
        tabs.append(group);
    }
    const tabItems = [...tabs.children] as HTMLElement[];
    workspaceTabs = tabItems;
    tabs.replaceChildren();
    const workspaces = el('div', 'workspace-controls');
    workspaces.append(tabs, button(t("app.newWorkspace"), 'Plus', createWorkspace));
    top.append(workspaces);
    const right = el('div', 'topbar-right'), additions = el('div', 'panel-additions');
    for (const [kind, label, name] of [['files', t("app.addFileBrowser"), 'FolderPlus'], ['terminal', t("app.addTerminal"), 'SquareTerminal']] as const) {
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
        const arrange = button(t("app.rearrangeWorkspace"), 'LayoutPanelTop', () => {
            rearrangeWorkspace();
            clearTimeout(collapseTimer);
            arrange.classList.add('expanded');
            if (!arrange.matches(':hover')) collapseLater();
        }, 'layout-cycle');
        arrange.title = t("app.autoLayout");
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
    right.append(button(t("app.toggleLightOrDarkTheme"), settings.theme === 'dark' ? 'Sun' : 'Moon', () => {
        settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = settings.theme; changed(); renderChrome();
    }, 'theme-toggle'));
    const sound = audioControl();
    right.append(sound.control); chromeDisposers.push(sound.dispose);
    const account = button(t("app.userMenu"), undefined, () => userMenu(account), 'user-menu-button');
    account.replaceChildren(el('span', 'username', user.name), icon('Menu'));
    account.setAttribute('aria-haspopup', 'menu');
    setMenuWarning(account, accountActions().flatMap(action => action[3] ? [action[3]] : []).join('\n'));
    right.append(account); top.append(right);
    const componentTabs = el('nav', 'component-tabs');
    componentTabs.setAttribute('aria-label', t("app.components"));
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
        const menu = button(t("app.componentMenu"), 'ChevronDown', () => componentMenu(panel, menu), 'component-menu');
        menu.dataset.componentMenu = panel.id;
        menu.setAttribute('aria-haspopup', 'menu'); group.append(menu);
        components.push(group);
    }
    root.prepend(top, componentControls);
    updateLayoutButton();
    chromeDisposers.push(overflowTabs(tabs, tabItems, t("app.moreWorkspaces"), compact ? undefined : items => {
        settings.workspaces = items.map(item => settings.workspaces.find(ws => ws.id === item.dataset.workspace)!);
        changed();
    }));
    if (compact) chromeDisposers.push(overflowTabs(componentTabs, components, t("app.moreComponents")));
    mounted?.grid?.cellHeight(cellHeight(mounted));
    mounted?.items.forEach(item => item.view.resize?.());
}
function cellHeight(value: Mounted) { return Math.max(140, value.gridEl.clientHeight / value.ws.rows); }
function syncWorkspace(value: Mounted, previousRects?: Map<string, DOMRect>) {
    const { ws, board, gridEl, items } = value;
    const before = previousRects || new Map([...items].map(([id, item]) => [id, item.node.getBoundingClientRect()]));
    const compact = isCompact();
    const rotated = orientWorkspace(ws);
    if (rotated) changed();
    if (compact !== value.compact || rotated) { value.grid?.destroy(false); value.grid = undefined; value.compact = compact; }
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
            const title = el('span', 'panel-title', panel.kind === 'files' ? t("common.files") : t("common.terminal"));
            const tools = el('div', 'panel-tools');
            tools.append(button(t("app.closePanel"), 'X', () => closePanel(panel)));
            head.append(icon(panel.kind === 'files' ? 'Folder' : 'SquareTerminal'), title, tools);
            head.ondblclick = event => { if (!(event.target as Element).closest('button:not(.terminal-tab)')) { const owner = item!.owner, ws = owner.ws, before = ws.panels.map(p => ({ ...p })); Object.assign(panel, expandPanel(ws, panel)); layoutChanged(ws, before); syncWorkspace(owner); } };
            head.onpointerdown = event => {
                if (!item!.owner.compact && !(event.target as Element).closest('button:not(.terminal-tab)')) beginDrag(event, panel.kind, panel);
            };
            bindContextMenu(head, position => componentMenu(panel, head, position, true));
            scopeNotifications(tools, content);
            tools.onpointerdown = event => event.stopPropagation();
            const body = el('div', 'panel-body');
            content.append(head, body); node.append(content); gridEl.append(node);
            for (const edge of ['e', 's', 'w', 'se', 'sw']) {
                const grip = el('div', `panel-resize panel-resize-${edge}`);
                grip.onpointerdown = event => beginPanelResize(item!.owner, panel, edge, event);
                node.append(grip);
            }
            const hooks = { user, changed, editorLineWrap: () => settings.editorLineWrap !== false, setEditorLineWrap, defaultDirectory: () => defaultDirectory(item?.owner.ws || ws), workspaceDefault: (path: string) => setWorkspaceDirectory(item?.owner.ws || ws, path), close: () => closePanel(panel), openTerminal: (path: string) => addPanel('terminal', path), openFileBrowser: (path: string, line?: number, column?: number) => openFileBrowser(item!.owner, path, line, column), title: (name: string) => { title.textContent = name; const tab = document.querySelector<HTMLButtonElement>(`[data-component-name="${panel.id}"]`); if (tab) { tab.querySelector('.component-tab-title')!.textContent = name; tab.title = name; tab.setAttribute('aria-label', name); window.dispatchEvent(new Event('tuxee-tabs-changed')); } } };
            const view = panel.kind === 'files' ? new FileView(body, panel, hooks) : new TerminalView(body, panel, hooks, settings.terminalFontSize, settings.terminalFontFamily || TERMINAL_FONT.family);
            item = { owner: value, node, view, tools, title }; items.set(panel.id, item);
        }
        item.node.hidden = compact && panel.id !== ws.active;
        for (const key of ['x', 'y', 'w', 'h'] as const) item.node.setAttribute(`gs-${key}`, String(panel[key]));
        item.node.setAttribute('gs-id', panel.id);
    }
    if (!compact) {
        if (!value.grid) {
            value.grid = GridStack.init({ rtl: false, column: ws.columns, maxRow: ws.rows, cellHeight: cellHeight(value), margin: 5, float: true, disableDrag: true, disableResize: true, animate: false }, gridEl);
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
function beginPanelResize(value: Mounted, panel: Panel, edge: string, event: PointerEvent) {
    if (event.button !== 0 || dragging || value.compact) return;
    event.preventDefault(); event.stopPropagation(); cancelDrag(); finishSlide();
    const { ws, gridEl, items } = value, trigger = event.currentTarget as HTMLElement;
    const node = items.get(panel.id)!.node, snapshot = { ...ws, panels: ws.panels.map(p => ({ ...p })) };
    const origin = snapshot.panels.find(p => p.id === panel.id)!;
    const cellW = gridEl.clientWidth / ws.columns, cellH = cellHeight(value);
    const events = new AbortController(), cursor = document.body.style.cursor;
    let active = false, plan: Panel[] | undefined;
    trigger.setPointerCapture(event.pointerId);
    function finish(cancelled = false) {
        events.abort(); cancelDrag = () => {};
        if (trigger.hasPointerCapture(event.pointerId)) trigger.releasePointerCapture(event.pointerId);
        if (!active) return;
        const released = new Map([...items].map(([id, item]) => [id, item.node.getBoundingClientRect()]));
        dragging = false; hidePreview(); value.board.classList.remove('resizing-panel');
        node.classList.remove('panel-dragging'); document.body.style.cursor = cursor;
        if (!cancelled && plan) {
            for (const { id, x, y, w, h } of plan) Object.assign(ws.panels.find(p => p.id === id)!, { x, y, w, h });
            layoutChanged(ws, snapshot.panels);
        }
        for (const property of ['left', 'top', 'width', 'height']) node.style.removeProperty(property);
        syncWorkspace(value, released);
    }
    cancelDrag = () => finish(true);
    trigger.addEventListener('pointermove', move => {
        const dx = (move.clientX - event.clientX) / cellW, dy = (move.clientY - event.clientY) / cellH;
        if (!active && Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) < 3) return;
        if (!active) {
            items.forEach(item => item.node.getAnimations().forEach(animation => animation.cancel()));
            active = dragging = true; value.board.classList.add('resizing-panel'); node.classList.add('panel-dragging');
            document.body.style.cursor = getComputedStyle(trigger).cursor;
        }
        const x = edge.includes('w') ? Math.max(0, Math.min(origin.x + origin.w - 1, origin.x + dx)) : origin.x;
        const right = edge.includes('e') ? Math.max(origin.x + 1, Math.min(ws.columns, origin.x + origin.w + dx)) : origin.x + origin.w;
        const bottom = edge.includes('s') ? Math.max(origin.y + 1, Math.min(ws.rows, origin.y + origin.h + dy)) : origin.y + origin.h;
        const rect = { x: Math.round(x), y: origin.y, w: Math.round(right) - Math.round(x), h: Math.round(bottom) - origin.y };
        plan = dropLayout(snapshot, origin, rect);
        Object.assign(node.style, { left: `${x * cellW}px`, top: `${origin.y * cellH}px`, width: `${(right - x) * cellW}px`, height: `${(bottom - origin.y) * cellH}px` });
        items.get(panel.id)!.view.resize?.();
        showPreview(gridEl, { x: rect.x * cellW, y: rect.y * cellH, w: rect.w * cellW, h: rect.h * cellH }, 'resize', !plan);
    }, { signal: events.signal });
    trigger.addEventListener('pointerup', () => finish(), { signal: events.signal });
    trigger.addEventListener('pointercancel', () => finish(true), { signal: events.signal });
    trigger.addEventListener('lostpointercapture', () => finish(true), { signal: events.signal });
    window.addEventListener('blur', () => finish(true), { signal: events.signal });
    window.addEventListener('resize', () => finish(true), { signal: events.signal });
    document.addEventListener('keydown', key => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(true); } }, { capture: true, signal: events.signal });
}
function renderDividers(value: Mounted) {
    const { ws, gridEl } = value;
    const focused = (document.activeElement as HTMLElement)?.dataset.divider;
    gridEl.querySelectorAll('.workspace-divider').forEach(node => node.remove());
    if (value.compact) return;
    const dividers = sharedDividers(ws);
    function handle(axes: Divider[], x: number, y: number, w: number, h: number, junction = false) {
        const movable = axes.filter(d => d.min < d.max);
        if (!movable.length || (junction && movable.length < 2)) return;
        const node = el('div', 'workspace-divider');
        node.dataset.divider = axes.map(d => `${d.axis}:${d.before.join(',')}:${d.after.join(',')}`).join('/');
        node.dataset.axis = movable.length === 2 ? 'both' : movable[0].axis;
        node.classList.toggle('divider-junction', junction);
        node.tabIndex = 0;
        node.setAttribute('role', junction ? 'button' : 'separator');
        node.setAttribute('aria-label', junction ? t("app.resizeAdjoiningPanels") : t("app.resizePanels"));
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
    document.addEventListener('keydown', key => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(true); } }, { capture: true, signal: events.signal });
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
    if (existing && mounted.items.get(existing.id)?.node.dataset.moving) return;
    cancelDrag(); finishSlide();
    const value = mounted, ws = value.ws, trigger = (event.target as Element).closest<HTMLElement>('.terminal-tab, .path-input') || event.currentTarget as HTMLElement;
    const panel = existing || newPanel(kind, defaultDirectory(ws));
    const node = existing ? value.items.get(existing.id)!.node : el('section', 'panel new-panel-drag');
    node.getAnimations().forEach(animation => animation.cancel());
    const origin = existing ? node.getBoundingClientRect() : new DOMRect(event.clientX, event.clientY, 180, 100);
    const startX = event.clientX, startY = event.clientY;
    let active = false, where: DropTarget | undefined, workspaceTarget: Workspace | undefined;
    const dropTabs = workspaceTabs;
    const clearTabs = () => dropTabs.forEach(tab => { delete tab.dataset.componentDrop; });
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
        dragging = false; hidePreview(); value.board.classList.remove('docking'); clearTabs();
        document.querySelector<HTMLElement>('.overflow-tabs:popover-open')?.hidePopover();
        if (!cancelled && existing && workspaceTarget && workspaceTarget !== ws && workspaceTarget.panels.length < 8) {
            movePanel(existing, workspaceTarget).catch(error => notify(error, node));
            return;
        }
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
    document.addEventListener('keydown', key => { if (key.key === 'Escape') { key.preventDefault(); finish(true); } }, { capture: true, signal: events.signal });
    trigger.addEventListener('pointercancel', () => finish(true), { signal: events.signal });
    trigger.addEventListener('lostpointercapture', () => finish(true), { signal: events.signal });
    trigger.addEventListener('pointerup', () => finish(), { signal: events.signal });
    window.addEventListener('blur', () => finish(true), { signal: events.signal });
    window.addEventListener('resize', () => finish(true), { signal: events.signal });
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
        workspaceTarget = undefined;
        clearTabs();
        if (existing) {
            const more = document.querySelector<HTMLButtonElement>('.workspace-tabs .overflow-toggle'), bounds = more?.getBoundingClientRect();
            if (more && !more.hidden && bounds && move.clientX >= bounds.left && move.clientX < bounds.right && move.clientY >= bounds.top && move.clientY < bounds.bottom) {
                if (more.getAttribute('aria-expanded') !== 'true') more.click();
                where = undefined; hidePreview(); return;
            }
            const tab = dropTabs.find(tab => { const r = tab.getBoundingClientRect(); return tab.checkVisibility() && move.clientX >= r.left && move.clientX < r.right && move.clientY >= r.top && move.clientY < r.bottom; });
            if (tab) {
                workspaceTarget = settings.workspaces.find(ws => ws.id === tab.dataset.workspace);
                tab.dataset.componentDrop = workspaceTarget !== ws && workspaceTarget!.panels.length < 8 ? 'allowed' : 'blocked';
                where = undefined; hidePreview(); return;
            }
        }
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
function rearrangeWorkspace() {
    if (!mounted || !current().panels.length) return;
    cycleLayout(current(), mounted.gridEl.clientWidth, mounted.gridEl.clientHeight);
    changed(); syncWorkspace(mounted); updateLayoutButton(true);
}
function updateLayoutButton(advance = false) {
    const button = root.querySelector<HTMLButtonElement>('.layout-cycle');
    if (!button) return;
    const mode = current().layout?.mode || 0, names = [t("app.custom"), t("app.balanced"), t("app.terminals"), t("common.files")];
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
function panelSize(panel: Panel) {
    if (!mounted!.compact) return mounted!.items.get(panel.id)!.node.querySelector('.panel')!.getBoundingClientRect();
    // Compact tabs share one screen; measure their saved rectangles in the workspace grid.
    const { width, height } = mounted!.gridEl.getBoundingClientRect(), ws = current();
    return { width: panel.w * width / ws.columns, height: panel.h * height / ws.rows };
}
function splitPanel(target: Panel, panel: Panel) {
    const { width, height } = panelSize(target);
    const edge = target.w > 1 && (target.h === 1 || width >= height) ? 'right' : 'bottom';
    return split(current(), target.id, panel, edge);
}
function addPanel(kind: Kind, path = defaultDirectory(current()), terminal?: TerminalInfo, near?: { x: number; y: number }) {
    const ws = current(), panel = newPanel(kind, path);
    if (terminal) panel.terminal = terminal.id;
    const full = ws.panels.reduce((sum, p) => sum + p.w * p.h, 0) === ws.columns * ws.rows;
    const target = !near && full && ws.panels.filter(p => p.w > 1 || p.h > 1)
        .sort((a, b) => b.w * b.h - a.w * a.h || Number(a.kind === 'terminal') - Number(b.kind === 'terminal'))[0];
    if (!(target ? splitPanel(target, panel) : addCompact(ws, panel, near))) throw new Error(t("app.workspaceFull"));
    ws.active = panel.id; layoutChanged(ws); render();
    return panel;
}
async function openFileBrowser(owner: Mounted, path: string, line?: number, column?: number) {
    const { entry } = await api('/files', 'POST', { operation: 'stat', path });
    if (mounted !== owner || current() !== owner.ws) return;
    let panel = owner.ws.panels.find(panel => panel.kind === 'files' && owner.items.get(panel.id)?.view instanceof FileView && !(owner.items.get(panel.id)!.view as FileView).pinned);
    if (!panel) panel = addPanel('files', entry.directory ? entry.path : entry.path.split('/').slice(0, -1).join('/') || '/');
    const view = owner.items.get(panel.id)?.view;
    if (!(view instanceof FileView) || !await view.openPath(entry.path, line, column)) return;
    if (mounted !== owner || !owner.ws.panels.includes(panel)) return;
    activatePanel(panel);
    view.focusOpened();
}
function addSplitPanel(kind: Kind, target: Panel) {
    const ws = current(), panel = newPanel(kind, defaultDirectory(ws));
    if (!splitPanel(target, panel)) return;
    ws.active = panel.id; layoutChanged(ws); render();
}
function stopPanel(panel: Panel, value?: Mounted) {
    if (panel.kind !== 'terminal') return;
    const view = value?.items.get(panel.id)?.view;
    (view instanceof TerminalView ? view.close() : terminateTerminal(panel)).catch(notify).finally(() => refreshTerminals());
}
async function movePanel(panel: Panel, target: Workspace) {
    const source = [...warmWorkspaces.values()].find(value => value.items.has(panel.id)), item = source?.items.get(panel.id);
    if (!source || !item || source.ws === target || item.node.dataset.closing || item.node.dataset.moving) return;
    if (target.panels.length >= 8) throw new Error(t("app.workspaceFull"));
    const node = item.node, style = node.getAttribute('style'), from = node.getBoundingClientRect();
    node.dataset.moving = 'true';
    let flight: HTMLElement | undefined;
    try {
        const tab = [...document.querySelectorAll<HTMLElement>('.workspace-tab-item')].find(tab => tab.dataset.workspace === target.id && tab.checkVisibility())
            || document.querySelector<HTMLElement>('.workspace-tabs .overflow-toggle');
        if (tab && from.width && from.height && duration(220)) {
            const to = tab.getBoundingClientRect();
            flight = el('div', 'grid-stack component-flight');
            Object.assign(flight.style, { left: `${from.x}px`, top: `${from.y}px`, width: `${from.width}px`, height: `${from.height}px` });
            Object.assign(node.style, { left: '0', top: '0', width: '100%', height: '100%', transform: 'none' });
            node.classList.remove('panel-dragging');
            flight.append(node); document.body.append(flight);
            await flight.animate([{ transform: 'none', opacity: .9 }, { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${to.width / from.width}, ${to.height / from.height})`, opacity: 0 }],
                { duration: duration(220), easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' }).finished.catch(() => {});
        }
        while (!warmWorkspaces.has(target.id) && warmWorkspaces.size >= MAX_WARM_WORKSPACES) {
            const oldest = [...warmWorkspaces.values()].find(value => value !== mounted && value !== source)!;
            if (!await canLeave(oldest)) return;
            if (warmWorkspaces.get(oldest.ws.id) === oldest) destroyWorkspace(oldest);
        }
        if (!loggedIn || warmWorkspaces.get(source.ws.id) !== source || !settings.workspaces.includes(target) || !source.ws.panels.includes(panel)) return;
        const plan = structuredClone(target), incoming = { ...panel }, vacated = { ...panel };
        orientWorkspace(plan);
        if (!addCompact(plan, incoming)) throw new Error(t("app.workspaceFull"));
        const destination = warmWorkspaces.get(target.id) || mountWorkspace(target);
        if (target.columns !== plan.columns || target.rows !== plan.rows) { destination.grid?.destroy(false); destination.grid = undefined; }
        target.columns = plan.columns; target.rows = plan.rows;
        for (const next of plan.panels) Object.assign(target.panels.find(p => p.id === next.id) || panel, next);
        source.gridEl.append(node); source.grid?.removeWidget(node, false, false); source.items.delete(panel.id);
        source.ws.panels = source.ws.panels.filter(p => p !== panel);
        if (source.ws.active === panel.id) source.ws.active = source.ws.panels[0]?.id || '';
        target.panels.push(panel); target.active = panel.id;
        item.owner = destination; destination.items.set(panel.id, item);
        if (!source.compact) expandAfterClose(source.ws, vacated, source.ws.panels.filter(p => !source.items.get(p.id)?.node.dataset.closing));
        layoutChanged(source.ws); layoutChanged(target);
    } finally {
        style === null ? node.removeAttribute('style') : node.setAttribute('style', style);
        node.style.transform = ''; node.classList.remove('panel-dragging'); delete node.dataset.moving;
        if (warmWorkspaces.get(item.owner.ws.id) === item.owner) item.owner.gridEl.append(node);
        else node.remove();
        flight?.remove();
        if (loggedIn) render();
    }
}
async function closePanel(panel: Panel) {
    const value = mounted, item = value?.items.get(panel.id);
    if (!value || !item || item.node.dataset.closing || item.node.dataset.moving) return;
    if (item.view.canClose && !await item.view.canClose()) return;
    item.node.dataset.closing = 'true';
    const animation = item.node.animate([{ opacity: 1, transform: 'scale(1)', transformOrigin: 'center' }, { opacity: 0, transform: 'scale(.96)', transformOrigin: 'center' }], { duration: duration(160), fill: 'forwards' });
    try {
        stopPanel(panel, value);
        await animation.finished;
        value.ws.panels = value.ws.panels.filter(p => p.id !== panel.id);
        if (!value.compact) expandAfterClose(value.ws, panel,
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
    if (settings.workspaces.length >= 12) { notify(t("app.workspaceLimitReached")); return; }
    if (warmWorkspaces.size >= MAX_WARM_WORKSPACES && !await canLeave(warmWorkspaces.values().next().value)) return;
    const ws = newWorkspace(t("app.workspaceNumber", { count: settings.workspaces.length + 1 }), defaultDirectory()); settings.workspaces.push(ws); await switchWorkspace(ws.id, true);
}
async function renameWorkspace(ws: Workspace) {
    const name = await ask(t("app.renameWorkspace"), t("common.name"), ws.name);
    if (!name) return;
    if (name.length > 60) throw new Error(t("app.nameIsTooLong"));
    ws.name = name; changed(); renderChrome();
}
async function setWorkspaceDirectory(ws: Workspace, path: string) {
    const previous = ws.defaultDirectory;
    if (!path || directoryPath(path, user.home) === defaultDirectory()) delete ws.defaultDirectory;
    else ws.defaultDirectory = path;
    try { await save(); }
    catch (error) { ws.defaultDirectory = previous; throw error; }
}
function editWorkspaceDirectory(ws: Workspace) {
    const form = el('form', 'form'), input = el('input'), field = el('label', 'field', t("common.directory"));
    input.dir = 'ltr';
    input.value = ws.defaultDirectory || settings.defaultDirectory || '~';
    input.maxLength = 4096; input.autocomplete = 'off'; input.spellcheck = false;
    field.append(input);
    const description = el('small', 'muted', t("app.usedAsEntryDirectoryForNewTerminalsAndFileManagers"));
    description.id = 'default-directory-description'; input.setAttribute('aria-describedby', description.id);
    const submit = button(t("common.save"), undefined, undefined, 'primary'); submit.type = 'submit';
    const actions = el('div', 'actions');
    actions.append(button(t("common.cancel"), undefined, () => dialog.close()), submit);
    form.append(field, description, actions);
    const dialog = modal(t("app.defaultDirectory"), form);
    form.onsubmit = async event => {
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        try { await setWorkspaceDirectory(ws, input.value); dialog.close(); }
        catch (error) { notify(error, form); }
        finally { submit.disabled = false; }
    };
    input.focus(); input.select();
}
function workspaceMenu(ws: Workspace, tab: HTMLElement, position?: { x: number; y: number }) {
    tabMenu(tab, t("app.workspaceLabel", { name: ws.name }), ws.id === settings.current, [
        [t("app.activate"), 'ArrowRight', () => switchWorkspace(ws.id), ws.id === current().id],
        [t("common.rename"), 'Pencil', () => renameWorkspace(ws)],
        [t("app.defaultDirectory"), 'Folder', () => editWorkspaceDirectory(ws)],
        [t("common.close"), 'X', () => closeWorkspace(ws)],
    ], position);
}
function activatePanel(panel: Panel) { current().active = panel.id; changed(); render(); }
function componentMenu(panel: Panel, tab: HTMLElement, position?: { x: number; y: number }, header = false) {
    const item = mounted!.items.get(panel.id)!;
    const actions: (TabAction | TabSubmenu)[] = header ? [] : [[t("app.activate"), 'ArrowRight', () => activatePanel(panel), panel.id === current().active]];
    for (const [kind, label, name] of [['terminal', t("app.addTerminal"), 'SquareTerminal'], ['files', t("app.addFileBrowser"), 'FolderPlus']] as const)
        actions.push([label, name, () => addSplitPanel(kind, panel), panel.w === 1 && panel.h === 1]);
    actions.push({ label: t("app.moveToWorkspace"), items: settings.workspaces.map(ws => ({ label: ws.name, disabled: ws === current() || ws.panels.length >= 8, description: ws === current() ? t("app.currentWorkspace") : ws.panels.length >= 8 ? t("app.workspaceFull") : '', action: () => movePanel(panel, ws) })) });
    if (item.view.renamePanel) actions.push([t("common.rename"), 'Pencil', () => item.view.renamePanel!()]);
    actions.push([t("common.close"), 'X', () => closePanel(panel)]);
    const control = item.tools.querySelector<HTMLButtonElement>('[data-action="take-control"]');
    if (!header && control && !control.hidden) actions.splice(1, 0, [t("app.takeControl"), 'Hand', () => control.click()]);
    tabMenu(tab, item.title.textContent || panel.kind, panel.id === current().active, actions, position);
}
type TabAction = [string, Parameters<typeof icon>[0], () => unknown, boolean?];
type TabSubmenu = { label: string; items: { label: string; disabled: boolean; description: string; action: () => unknown }[] };
function tabMenu(tab: HTMLElement, title: string, active: boolean, actions: (TabAction | TabSubmenu)[], position?: { x: number; y: number }) {
    const content = el('div', 'menu-actions');
    content.setAttribute('aria-label', title);
    const item = mounted?.items.get(tab.dataset.componentName || tab.dataset.componentMenu || tab.closest<HTMLElement>('[data-panel]')?.dataset.panel || '');
    if (item) scopeNotifications(content, item.node.querySelector<HTMLElement>('.panel')!);
    let close = () => {};
    for (const entry of actions) {
        if (!Array.isArray(entry)) {
            const children = el('div', 'menu-actions menu-submenu'); children.hidden = true;
            children.setAttribute('role', 'menu'); children.setAttribute('aria-label', entry.label);
            const toggle = button(entry.label, 'MoveRight', () => expand(children.hidden));
            toggle.append(el('span', '', entry.label), icon('ChevronRight')); toggle.setAttribute('role', 'menuitem'); toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false');
            const expand = (open: boolean) => {
                children.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
                if (open) {
                    content.style.top = `${Math.max(4, Math.min(parseFloat(content.style.top), innerHeight - content.offsetHeight - 4))}px`;
                    children.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
                } else toggle.focus();
            };
            for (const target of entry.items) {
                const choice = button(target.label, 'LayoutPanelTop', () => { close(); return target.action(); });
                choice.append(el('span', '', target.label)); choice.disabled = target.disabled; choice.title = target.description || target.label;
                choice.setAttribute('role', 'menuitem'); children.append(choice);
            }
            toggle.addEventListener('keydown', event => { if (event.key === (document.documentElement.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight')) { event.preventDefault(); expand(true); } });
            children.addEventListener('keydown', event => { if (event.key === (document.documentElement.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft')) { event.preventDefault(); event.stopPropagation(); expand(false); } });
            content.append(toggle, children); continue;
        }
        const [label, name, action, disabled = false] = entry;
        const control = button(label, name, () => { close(); return action(); });
        control.disabled = disabled;
        control.append(el('span', '', label)); control.setAttribute('role', 'menuitem'); content.append(control);
    }
    const rect = tab.getBoundingClientRect();
    const returnFocus = tab.classList.contains('panel-header') ? document.activeElement as HTMLElement : tab;
    ({ close } = popover(position || { x: rect.left, y: rect.bottom }, content, returnFocus));
}
async function closeWorkspace(ws = current()) {
    const value = warmWorkspaces.get(ws.id);
    if (!await canLeave(value)) return;
    if (!await confirmAction(t("app.closeNamedWorkspace", { name: ws.name }), t("app.stopAllTerminalsInThisWorkspace"), t("app.closeWorkspace"))) return;
    const index = settings.workspaces.indexOf(ws), active = settings.current === ws.id;
    ws.panels.forEach(panel => stopPanel(panel, value));
    settings.workspaces = settings.workspaces.filter(value => value.id !== ws.id);
    warmWorkspaces.delete(ws.id);
    if (value !== mounted && value !== outgoing) destroyWorkspace(value);
    if (!settings.workspaces.length) settings.workspaces.push(newWorkspace(t('app.workspaceNumber', { count: 1 }), defaultDirectory()));
    if (active) settings.current = settings.workspaces[Math.max(0, index - 1)].id;
    changed(); render(active ? (index ? -1 : 1) : 0);
}
function unlistedTerminals() {
    const listed = new Set(settings.workspaces.flatMap(ws => ws.panels.filter(panel => panel.kind === 'terminal').map(panel => panel.terminal)));
    return terminalSessions.filter(info => !info.closedAt && (info.exited || !listed.has(info.id)));
}
function stopTerminalPolling() {
    clearTimeout(terminalTimer); terminalRequest?.abort();
}
function refreshTerminals(): Promise<boolean> {
    clearTimeout(terminalTimer);
    if (!loggedIn || document.hidden) { stopTerminalPolling(); return Promise.resolve(false); }
    // Keep post-mutation reads fresh without cancelling a menu's pending read.
    const refresh = async () => {
        clearTimeout(terminalTimer);
        if (!loggedIn || document.hidden) return false;
        const request = terminalRequest = new AbortController();
        try {
            const sessions = await api<TerminalInfo[]>('/terminals', 'GET', undefined, request.signal);
            if (request.signal.aborted) return false;
            terminalSessions = sessions; terminalError = '';
        } catch (error) {
            if (request.signal.aborted) return false;
            terminalError = error instanceof Error ? errorText(error) : t("app.retainedUnavailable");
        }
        updateMenuWarnings();
        terminalTimer = setTimeout(() => refreshTerminals(), 10000);
        return !terminalError;
    };
    terminalRefresh = terminalRefresh.then(refresh, refresh);
    return terminalRefresh;
}

function editShortcuts() {
    openShortcuts(() => settings.shortcuts, async value => {
        const previous = settings.shortcuts;
        settings.shortcuts = value;
        try { await save(); }
        catch (error) { settings.shortcuts = previous; throw error; }
    });
}
function focusActivePanel() {
    const view = mounted?.items.get(current().active)?.view;
    if (view instanceof TerminalView) void view.focus();
    else if (view instanceof FileView) view.focus();
}
async function runShortcut(action: string) {
    const ws = current();
    const focused = document.activeElement?.closest<HTMLElement>('[data-panel]')?.dataset.panel || ws.active;
    if (action.startsWith('desktop.') && action !== 'desktop.add' && action !== 'desktop.close') {
        const index = settings.workspaces.indexOf(ws), direction = document.documentElement.dir === 'rtl' ? -1 : 1;
        const target = action === 'desktop.previous' ? index - direction : action === 'desktop.next' ? index + direction : Number(action.split('.')[1]) - 1;
        const next = settings.workspaces[(target + settings.workspaces.length) % settings.workspaces.length];
        if (/^desktop\.\d+$/.test(action) && target >= settings.workspaces.length) return;
        if (next) { await switchWorkspace(next.id); focusActivePanel(); }
        return;
    }
    if (action === 'panel.next' || action === 'panel.previous') {
        const panels = ws.panels.filter(panel => {
            const node = mounted?.items.get(panel.id)?.node;
            return node && !node.dataset.closing && !node.dataset.moving;
        }).sort((a, b) => ws.columns > ws.rows ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x);
        if (!panels.length) return;
        const index = panels.findIndex(panel => panel.id === focused);
        activatePanel(panels[(index + (action === 'panel.next' ? 1 : -1) + panels.length) % panels.length]);
        focusActivePanel(); return;
    }
    switch (action) {
        case 'desktop.add': await createWorkspace(); focusActivePanel(); break;
        case 'desktop.close': await closeWorkspace(ws); focusActivePanel(); break;
        case 'panel.terminal': addPanel('terminal'); focusActivePanel(); break;
        case 'panel.files': addPanel('files'); focusActivePanel(); break;
        case 'panel.close': {
            const panel = ws.panels.find(panel => panel.id === focused);
            if (panel) { await closePanel(panel); focusActivePanel(); }
            break;
        }
        case 'panel.layout':
            if (isCompact()) rearrangeWorkspace();
            else root.querySelector<HTMLButtonElement>('.layout-cycle')?.click();
            break;
        case 'audio.mute': toggleMute(); break;
        case 'audio.up': adjustVolume(5); break;
        case 'audio.down': adjustVolume(-5); break;
        case 'app.monitor': monitoring?.open(); break;
        case 'app.about': openAbout(); break;
        case 'app.settings': await openSettings(); break;
        case 'app.retained': await retainedTerminals(); break;
        case 'app.shortcuts': editShortcuts(); break;
        case 'app.restart': await restartTuxee(); break;
        case 'app.logout': await logout(); break;
    }
}
const disposeShortcuts = installShortcuts(() => settings.shortcuts || {}, () => loggedIn && !loggingOut && !dragging, runShortcut);

function accountActions(): [string, Parameters<typeof icon>[0], () => unknown, string?][] {
    const count = unlistedTerminals().filter(info => !info.exited).length;
    const actions: ReturnType<typeof accountActions> = [
        [t("app.settings"), 'Settings', openSettings],
        [t("shortcuts.title"), 'Keyboard', editShortcuts],
        [t("app.retainedTerminals"), 'SquareTerminal', retainedTerminals, terminalError || (count ? t(count === 1 ? 'app.retainedOne' : 'app.retainedMany', { count }) : '')],
        [t("app.about"), 'Info', openAbout, updates?.warning],
        [t("app.restartTuxee"), 'RefreshCw', restartTuxee], [t("app.logOut"), 'LogOut', logout]
    ];
    if (monitoring) actions.unshift([t("app.resourceMonitor"), 'Activity', () => monitoring?.open()]);
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
    for (const [, name, , warning] of actions) {
        const control = document.querySelector<HTMLElement>(`.account-menu [data-action="${name}"]`);
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
        b.dataset.action = name!;
        b.append(el('span', '', label)); b.setAttribute('role', 'menuitem'); content.append(b);
        setMenuWarning(b, warning || '');
    }
    ({ close } = popover(anchor, content));
    void refreshTerminals();
}
async function openAbout() {
    const content = el('div', 'about-content'), logo = el('img', 'about-logo');
    logo.src = settings.theme === 'light' ? verticalLogoLight : verticalLogo;
    logo.alt = t("app.tuxee");
    logo.width = logo.height = 192; logo.draggable = false;
    const status = el('p', 'muted', t("common.loading"));
    status.setAttribute('role', 'status');
    const table = el('table', 'about-details'), body = el('tbody');
    table.setAttribute('aria-label', t("app.systemInformation"));
    const versionRow = el('tr'), versionHeading = el('th', '', t("app.tuxeeVersion")), version = el('td', '', '—');
    versionHeading.scope = 'row'; versionRow.append(versionHeading, version); body.append(versionRow);
    const githubRow = el('tr'), githubHeading = el('th', '', t("app.github")), githubCell = el('td');
    const github = el('a', '', 'agent0ai/tuxee');
    github.dir = 'ltr'; github.href = 'https://github.com/agent0ai/tuxee'; github.target = '_blank'; github.rel = 'noopener noreferrer';
    githubHeading.scope = 'row'; githubCell.append(github); githubRow.append(githubHeading, githubCell);
    table.append(body);
    content.append(logo, el('p', 'about-tagline muted', t("app.tagline")), table, status);
    const { dialog } = modal(t("app.aboutTuxee"), content);
    dialog.classList.add('about-modal');
    dialog.querySelector('h2')!.remove();
    const controller = new AbortController();
    dialog.addEventListener('close', () => controller.abort(), { once: true });
    if (updates) body.append(updates.view(controller.signal));
    body.prepend(githubRow);
    try {
        const info = await api<{ version: string; os: string; kernel: string; architecture: string; hostname: string; username: string; uid: number; home: string; shell: string }>('/system', 'GET', undefined, controller.signal);
        version.textContent = info.version || t("common.unavailable");
        for (const [label, value] of [
            [t("app.operatingSystem"), info.os], [t("app.kernel"), info.kernel],
            [t("app.architecture"), info.architecture], [t("app.serverName"), info.hostname],
            [t("app.user"), t("app.userIdentity", { name: info.username, uid: info.uid })], [t("app.homeDirectory"), info.home], [t("app.shell"), info.shell],
        ]) {
            const row = el('tr'), heading = el('th', '', label);
            heading.scope = 'row';
            row.append(heading, el('td', '', value || t("common.unavailable"))); body.append(row);
        }
        status.remove();
    } catch (error) {
        if (!controller.signal.aborted) {
            status.setAttribute('role', 'alert');
            status.textContent = error instanceof Error ? errorText(error) : t("app.systemInformationIsUnavailable");
        }
    }
}
async function retainedTerminals() {
    if (!await refreshTerminals()) throw new Error(terminalError || t("app.retainedUnavailable"));
    const content = el('div'), list = el('div', 'retained-list');
    const header = el('div', 'retained-header'), tabs = el('div', 'monitor-tabs');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', t("app.retainedTerminals"));
    let closed = false, busy = false;
    let displayed: TerminalInfo[] = [];
    const latest = (info: TerminalInfo) => Date.parse(info.closedAt || info.terminatedAt || info.foundDeadAt || info.startedAt || '') || 0;
    const age = (timestamp: number) => {
        const total = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
        const days = Math.floor(total / 1440), hours = Math.floor(total / 60) % 24, minutes = total % 60;
        return days ? t('term.ageDays', { days, hours, minutes }) : hours ? t('term.ageHours', { hours, minutes }) : t('term.ageMinutes', { minutes });
    };
    const activeTab = button('', undefined, () => select(false));
    const closedTab = button('', undefined, () => select(true));
    const all = button('', undefined, () => remove(displayed, true));
    all.dataset.action = 'all-terminals';
    for (const tab of [activeTab, closedTab]) { tab.setAttribute('role', 'tab'); tab.id = id(); tabs.append(tab); }
    list.id = id(); list.setAttribute('role', 'tabpanel');
    for (const tab of [activeTab, closedTab]) tab.setAttribute('aria-controls', list.id);
    tabs.onkeydown = event => {
        if (!busy && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); select(!closed); (closed ? closedTab : activeTab).focus(); }
    };
    header.append(tabs, all); content.append(header, list);
    const { close } = modal(t("app.retainedTerminals"), content);
    const select = (value: boolean) => { closed = value; paint(); };
    const date = (value: string) => {
        const d = new Date(value), pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const remove = async (entries: TerminalInfo[], bulk = false) => {
        if (busy || !entries.length) return;
        const deleting = closed;
        busy = true; paint();
        try {
            const action = t(deleting ? 'common.delete' : 'common.close');
            if (bulk || deleting) {
                if (!await confirmAction(t(deleting ? 'term.deleteArchives' : 'term.closeAll'), t(deleting ? 'term.deleteArchivesConfirm' : 'term.closeAllConfirm', { count: entries.length }), action)) return;
            } else if (!entries[0].exited && !await confirmAction(t("app.terminateTerminal"), t("terminal.stopNamed", { name: entries[0].name }), action)) return;
            let failure: unknown;
            for (const info of entries) {
                try { await api(`/terminals/${info.id}${deleting ? '/archive' : ''}`, 'DELETE'); }
                catch (error) { failure ??= error; }
            }
            if (!await refreshTerminals()) throw new Error(terminalError || t("app.retainedUnavailable"));
            updateMenuWarnings();
            if (failure) throw failure;
        } finally { busy = false; paint(); }
    };
    const paint = () => {
        const lost = unlistedTerminals(), archives = terminalSessions.filter(info => info.closedAt);
        for (const [tab, label] of [[activeTab, t('term.lostTerminals', { count: lost.length })], [closedTab, t('term.closedArchives', { count: archives.length })]] as const) {
            tab.textContent = tab.title = label;
            tab.setAttribute('aria-label', label);
        }
        activeTab.setAttribute('aria-selected', String(!closed)); closedTab.setAttribute('aria-selected', String(closed));
        activeTab.tabIndex = closed ? -1 : 0; closedTab.tabIndex = closed ? 0 : -1;
        activeTab.disabled = closedTab.disabled = busy;
        list.setAttribute('aria-labelledby', (closed ? closedTab : activeTab).id);
        list.replaceChildren();
        const entries = displayed = (closed ? archives : lost).sort((a, b) => latest(b) - latest(a) || a.id.localeCompare(b.id));
        const label = t(closed ? 'term.deleteAll' : 'term.closeAll');
        all.title = label; all.setAttribute('aria-label', label);
        all.replaceChildren(icon(closed ? 'Trash2' : 'X'), el('span', '', t('term.all')));
        all.disabled = busy || !entries.length;
        if (!entries.length) list.append(el('p', 'muted', t(closed ? "term.noClosedTerminals" : "term.noLostTerminals")));
        for (const info of entries) {
            const row = el('div', 'retained-row'), text = el('div'), name = el('strong', 'retained-name');
            row.dataset.terminalId = info.id;
            const dot = el('span', 'retained-status'); dot.dataset.exited = String(info.exited); dot.setAttribute('aria-hidden', 'true');
            const title = el('span'), directory = el('bdi', 'retained-directory', info.directory); directory.dir = 'ltr';
            title.append(el('span', 'retained-label', info.name), ' ', directory);
            const timestamp = latest(info);
            if (timestamp) title.append(' ', el('bdi', 'retained-age', `• ${age(timestamp)}`));
            name.append(dot, title);
            const times = el('small', 'muted retained-times');
            const stamps = [
                [info.startedAt, 'term.startedAt'],
                info.closedAt ? [info.closedAt, 'term.closedAt'] : info.terminatedAt ? [info.terminatedAt, 'term.terminatedAt'] : [info.foundDeadAt, 'term.foundDeadAt'],
                [info.expiresAt, 'term.expiresAt'],
            ];
            for (const [value, key] of stamps) if (value) {
                if (times.childNodes.length) times.append(', ');
                times.append(el('bdi', '', t(key!, { time: `\u2066${date(value)}\u2069` })));
            }
            text.append(name, times);
            if (!info.exited) text.append(el('small', 'muted', t("terminal.summary", { pid: info.pid, state: t(info.attached ? 'terminal.attached' : 'terminal.detached') })));
            const open = button(t(info.exited ? "term.openArchive" : "app.attach"), undefined, () => {
                const panel = addPanel('terminal', info.directory, info);
                updateMenuWarnings(); close();
                const view = mounted?.items.get(panel.id)?.view;
                if (view instanceof TerminalView) return view.focus();
            });
            const action = button(t(closed ? 'common.delete' : 'common.close'), closed ? 'Trash2' : 'X', () => remove([info]));
            open.disabled = action.disabled = busy;
            row.append(text, open, action); list.append(row);
        }
    };
    paint();
}

async function openSettings() {
    const content = el('form', 'form settings-form');
    const serverName = el('input');
    serverName.name = 'serverName';
    serverName.maxLength = 64;
    serverName.value = settings.serverName || '';
    serverName.placeholder = hostname;
    const label = el('label', 'field');
    label.append(el('span', 'settings-label', t("app.serverName")));
    label.append(serverName);
    const directory = el('input');
    directory.name = 'defaultDirectory'; directory.value = settings.defaultDirectory || '~';
    directory.maxLength = 4096; directory.autocomplete = 'off'; directory.spellcheck = false;
    const directoryLabel = el('label', 'field');
    directoryLabel.append(el('span', 'settings-label', t("app.defaultDirectory")), directory);
    const shell = el('input');
    shell.name = 'shellCommand'; shell.value = settings.shellCommand || 'bash';
    shell.maxLength = 4096; shell.autocomplete = 'off'; shell.spellcheck = false;
    const shellLabel = el('label', 'field');
    shellLabel.append(el('span', 'settings-label', t("app.shellCommand")), shell);
    const prompt = el('input'); prompt.type = 'checkbox'; prompt.name = 'useTuxeePrompt';
    prompt.setAttribute('role', 'switch'); prompt.checked = settings.useTuxeePrompt !== false;
    const promptLabel = el('label', 'settings-switch');
    promptLabel.append(prompt, el('span', '', t("app.useTuxeeShellPrompt")));
    const fontSize = el('select'); fontSize.name = 'terminalFontSize';
    fontSize.setAttribute('aria-label', t('settings.terminalFontSize'));
    const fontSizes = [...Array.from({ length: 19 }, (_, i) => i + 6), 26, 28, 32, 36, 40, 48, 56, 64, 80, 96, 128];
    const savedFontSize = settings.terminalFontSize ?? TERMINAL_FONT.size;
    if (!fontSizes.includes(savedFontSize)) fontSizes.push(savedFontSize);
    for (const size of fontSizes.sort((a, b) => a - b)) {
        const option = el('option', '', `${size}px`); option.value = String(size); fontSize.append(option);
    }
    fontSize.value = String(savedFontSize);
    const fontFamily = el('input'); fontFamily.name = 'terminalFontFamily';
    fontFamily.value = settings.terminalFontFamily || TERMINAL_FONT.family;
    fontFamily.maxLength = TERMINAL_FONT.maxFamilyLength; fontFamily.autocomplete = 'off'; fontFamily.spellcheck = false;
    fontFamily.setAttribute('aria-label', t('settings.terminalFont'));
    const resetFont = button(t('common.reset'), undefined, () => {
        fontSize.value = String(TERMINAL_FONT.size); fontFamily.value = TERMINAL_FONT.family; updateFont();
    });
    const updateFont = () => {
        const family = fontFamily.value.trim();
        fontFamily.setCustomValidity(family && !CSS.supports('font-family', family) ? t('backend.server.terminalFontFamilyInvalid', { max: TERMINAL_FONT.maxFamilyLength }) : '');
        resetFont.disabled = Number(fontSize.value) === TERMINAL_FONT.size && family === TERMINAL_FONT.family;
    };
    fontSize.onchange = fontFamily.oninput = updateFont; updateFont();
    const fontControls = el('div', 'terminal-font-controls'); fontControls.append(fontSize, fontFamily, resetFont);
    const fontField = el('fieldset', 'field terminal-font');
    fontField.append(el('legend', 'settings-label', t('settings.terminalFont')), fontControls);
    let markerColor = settings.serverColor || '';
    const defaultColor = getComputedStyle(document.documentElement).getPropertyValue('--line').trim();
    const color = el('input');
    color.type = 'color'; color.id = 'server-color'; color.value = markerColor || defaultColor;
    const colorLabel = el('label', 'settings-label', t("app.colorMarker")); colorLabel.htmlFor = color.id;
    const reset = button(t("common.reset"), undefined, () => {
        markerColor = ''; color.value = defaultColor; reset.disabled = true; setColorMarker();
    });
    reset.disabled = !markerColor;
    color.oninput = () => { markerColor = color.value; reset.disabled = false; setColorMarker(markerColor); };
    const colors = el('div', 'settings-color'); colors.append(color, reset);
    const marker = el('div', 'field'); marker.append(colorLabel, colors);
    const terminalColors = { terminalBackground: settings.terminalBackground || '', terminalBackgroundLight: settings.terminalBackgroundLight || '' };
    const backgroundField = el('fieldset', 'field terminal-colors');
    backgroundField.append(el('legend', 'settings-label', t("app.terminalBackground")));
    const backgroundColumns = el('div', 'terminal-color-columns');
    for (const [key, label, fallback] of [
        ['terminalBackground', t("app.dark"), terminalTheme.background],
        ['terminalBackgroundLight', t("app.light"), '#f8f9fc']
    ] as const) {
        const background = el('input');
        background.type = 'color'; background.id = key; background.value = terminalColors[key] || fallback;
        const backgroundLabel = el('label', '', label); backgroundLabel.htmlFor = background.id;
        background.setAttribute('aria-label', t("settings.backgroundLabel", { theme: label }));
        const resetBackground = button(t("settings.backgroundReset", { theme: label.toLowerCase() }), undefined, () => {
            terminalColors[key] = ''; background.value = fallback; resetBackground.disabled = true;
        });
        resetBackground.textContent = t("common.reset"); resetBackground.disabled = !terminalColors[key];
        background.oninput = () => { terminalColors[key] = background.value; resetBackground.disabled = false; };
        const controls = el('div', 'settings-color'); controls.append(backgroundLabel, background, resetBackground);
        backgroundColumns.append(controls);
    }
    backgroundField.append(backgroundColumns);
    const retention = el('input'); retention.type = 'number'; retention.min = '0'; retention.max = '876000'; retention.step = '1'; retention.required = true;
    retention.name = 'closedTerminalHistoryHours'; retention.value = String(settings.closedTerminalHistoryHours ?? 168);
    const retentionLabel = el('label', 'field'); retentionLabel.append(el('span', 'settings-label', t("settings.closedTerminalHistory")), retention);
    const uploads = el('select');
    const uploadOptions = [1, 2, 4, 8, 16, 32, 64];
    for (const n of uploadOptions) {
        const option = el('option', '', n === 4 ? t("settings.defaultUploadConcurrency", { count: n }) : String(n));
        option.value = String(n); uploads.append(option);
    }
    uploads.value = String(uploadOptions.find(n => n >= (settings.uploadConcurrency ?? 4)));
    const uploadsLabel = el('label', 'field'); uploadsLabel.append(el('span', 'settings-label', t("app.parallelUploads")), uploads);
    const tls = await api('/tls');
    const https = location.protocol === 'https:';
    const certificate = https && (tls.source === 'public' || tls.source === 'local') ? tls.source : undefined;
    const details = el('section', 'tls-status');
    details.append(el('h3', '', t("app.connection")), el('p', '', !https ? t("app.plainHTTP") : certificate === 'public' ? t("settings.certificateExpiry", { date: new Date(tls.expires).toLocaleString(locale()) }) : certificate === 'local' ? t("app.encryptedWithALocalCertificate") : t("app.encryptedHTTPS")));
    if (certificate === 'local') {
        const link = el('a', 'text-link', t("app.downloadLocalCACertificate"));
        link.href = '/api/tls/ca';
        link.download = 'tuxee-local-ca.crt';
        details.append(link);
    }
    if (certificate && tls.error)
        details.append(el('p', 'muted', errorText(tls)));
    const submit = button(t("common.save"));
    submit.type = 'submit'; submit.className = 'primary';
    const actions = el('div', 'actions'); actions.append(submit);
    content.append(label, marker, el('hr'), shellLabel, promptLabel, fontField, backgroundField, directoryLabel, retentionLabel, el('hr'), uploadsLabel, el('hr'), details, actions);
    const dialog = modal(t("app.settings"), content);
    dialog.dialog.addEventListener('close', () => setColorMarker(settings.serverColor), { once: true });
    content.onsubmit = async event => {
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        const previous = settings.serverName;
        const previousColor = settings.serverColor;
        const previousUploads = settings.uploadConcurrency;
        const previousRetention = settings.closedTerminalHistoryHours;
        const previousBackground = settings.terminalBackground;
        const previousLightBackground = settings.terminalBackgroundLight;
        const previousFontSize = settings.terminalFontSize;
        const previousFontFamily = settings.terminalFontFamily;
        const previousDirectory = settings.defaultDirectory;
        const previousShell = settings.shellCommand, previousPrompt = settings.useTuxeePrompt;
        settings.serverName = serverName.value.trim();
        settings.serverColor = markerColor;
        settings.uploadConcurrency = Number(uploads.value);
        settings.closedTerminalHistoryHours = Number(retention.value);
        settings.terminalFontSize = Number(fontSize.value);
        settings.terminalFontFamily = fontFamily.value.trim();
        settings.defaultDirectory = directory.value || '~';
        settings.shellCommand = shell.value.trim() || 'bash'; settings.useTuxeePrompt = prompt.checked;
        Object.assign(settings, terminalColors);
        serverName.value = settings.serverName;
        try {
            await save();
            for (const workspace of warmWorkspaces.values()) for (const { view } of workspace.items.values()) {
                if (view instanceof TerminalView) view.setFont(settings.terminalFontSize, settings.terminalFontFamily || TERMINAL_FONT.family);
            }
            setUploadConcurrency(settings.uploadConcurrency); updateTitle(); dialog.close();
        }
        catch (error) { settings.serverName = previous; settings.serverColor = previousColor; settings.uploadConcurrency = previousUploads; settings.closedTerminalHistoryHours = previousRetention; settings.terminalBackground = previousBackground; settings.terminalBackgroundLight = previousLightBackground; settings.terminalFontSize = previousFontSize; settings.terminalFontFamily = previousFontFamily; settings.defaultDirectory = previousDirectory; settings.shellCommand = previousShell; settings.useTuxeePrompt = previousPrompt; notify(error, content); }
        finally { submit.disabled = false; }
    };
}
async function restartTuxee() {
    for (const value of warmWorkspaces.values()) if (!await canLeave(value)) return;
    if (!await confirmAction(t("app.restartConfirmationTitle"), t("app.restartConsequences"), t("app.restartTuxee"))) return;
    await save();
    try { await api('/restart', 'POST', {}); }
    catch (error) {
        if (error instanceof APIError && error.status === 403 && error.command) {
            const content = el('div');
            content.append(el('p', '', error.message), el('p', 'muted', t("app.restartPermissionHint")));
            content.append(el('code', 'update-command', error.command));
            modal(t("app.cannotRestartTuxee"), content);
            return;
        }
        throw error;
    }
    window.dispatchEvent(new Event('tuxee-connection-lost'));
}
async function logout() {
    for (const value of warmWorkspaces.values()) if (!await canLeave(value)) return;
    await save();
    if (loggingOut) return;
    loggingOut = true;
    try {
        await api('/logout', 'POST', {});
        setTranslations(await api<Translations>('/language'));
        showLogin();
    } finally { loggingOut = false; }
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
document.addEventListener('visibilitychange', () => { void refreshTerminals(); });
window.addEventListener('focus', () => { void refreshTerminals(); });
window.addEventListener('pagehide', () => { disposeShortcuts(); clearFileCut(); audio.available(false); updates?.dispose(); connection?.dispose(); stopTerminalPolling(); monitoring?.dispose(); disposeViews(); cancelTransfers(); });
connection = new BackendConnection(async (session, signal) => {
    if (!loggedIn) await load(signal);
    else if (session.uid === user.uid && (!session.language || session.language === translations().language)) setCSRF(session.csrf);
    else { showLogin(); location.reload(); }
}, () => {
    if (loggingOut) return;
    const ended = loggedIn;
    if (!root.querySelector('.login-page')) showLogin();
    if (ended) location.reload();
});
