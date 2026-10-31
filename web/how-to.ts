import { button, el, icon, modal } from './ui';
import { t } from './i18n';
import { dimensions } from './model';
import { bindings, shortcutActions, shortcutLabel, type ShortcutBindings } from './shortcuts';
import logoDark from './tuxee-logo-vertical.webp';
import logoLight from './tuxee-logo-vertical-light.webp';
import desktopImage from './howto-desktop.webp';
import desktopMenuImage from './howto-desktop-menu.webp';
import desktopLayoutImage from './howto-desktop-layout.webp';
import filesTransferImage from './howto-files-transfer.webp';
import filesMenuImage from './howto-files-menu.webp';
import filesEditorImage from './howto-files-editor.webp';
import filesTerminalImage from './howto-files-terminal.webp';
import terminalImage from './howto-terminal-live.webp';
import terminalArchiveImage from './howto-terminal-archive.webp';
import terminalRetainedImage from './howto-terminal-retained.webp';
import terminalDrawerImage from './howto-terminal-drawer.webp';
import terminalTextImage from './howto-terminal-text.webp';
import terminalFilesImage from './howto-terminal-files.webp';
import guiBrowserImage from './howto-gui-browser.webp';
import guiTerminalImage from './howto-gui-terminal.webp';
import customizationImage from './howto-tips-customization.webp';
import processesImage from './howto-tips-processes.webp';
import updatesImage from './howto-tips-updates.webp';
import './how-to.css';

export function openHowTo(savedShortcuts?: ShortcutBindings) {
    const existing = document.querySelector<HTMLDialogElement>('.howto-modal');
    if (existing) { existing.focus(); return existing; }
    const pages = [
        { title: t('howto.introduction'), heading: t('howto.welcome'), body: t('howto.introBody'), icon: 'BookOpen' },
        { title: t('app.workspaces'), body: t('howto.desktopBody'), icon: 'LayoutPanelTop' },
        { title: t('app.terminals'), body: t('howto.terminalBody'), icon: 'SquareTerminal' },
        { title: t('common.files'), body: t('howto.filesOverview'), icon: 'FolderOpen' },
        { title: t('howto.gui'), body: t('howto.guiBody'), icon: 'Monitor' },
        { title: t('howto.tips'), body: '', icon: 'Keyboard' },
    ] as const;
    const content = el('div', 'howto-content'), viewport = el('div', 'howto-viewport'), track = el('div', 'howto-track');
    viewport.append(track);
    let index = 0, animation: Animation | undefined;
    let active: HTMLElement;
    function navigation() {
        const nav = el('nav', 'howto-nav'); nav.setAttribute('aria-label', t('howto.title'));
        const previous = button('', undefined, () => show(index - 1), 'howto-previous');
        const next = button('', undefined, () => show(index + 1), 'howto-next');
        const dots = pages.map((page, target) => {
            const dot = button(page.title, undefined, () => show(target), 'howto-dot');
            dot.replaceChildren(el('span')); dot.dataset.page = String(target);
            return dot;
        });
        const group = el('div', 'howto-dots'), dotRow = el('div', 'howto-dot-row');
        group.append(...dots); dotRow.append(group);
        // Reserve every label's size so pagination never moves between pages.
        const size = el('span', 'howto-nav-size'); size.setAttribute('aria-hidden', 'true');
        for (const { title } of pages) {
            const label = el('span'); label.append(icon('ArrowLeft'), el('span', '', title)); size.append(label);
        }
        nav.append(size, previous, dotRow, next, size.cloneNode(true));
        return { nav, previous, next, dots };
    }
    function shortcuts(...actions: string[]) {
        const hint = el('aside', 'howto-shortcuts'), rows = el('table'), current = bindings(savedShortcuts);
        hint.setAttribute('aria-label', t('shortcuts.title'));
        for (const id of actions) {
            const sequences = current[id].filter(sequence => sequence.length);
            if (!sequences.length) continue;
            const row = el('tr', 'howto-shortcut'), label = el('th', '', shortcutActions.find(action => action.id === id)!.label()), value = el('td');
            row.dataset.shortcut = id; label.scope = 'row'; row.append(label, value);
            for (const sequence of sequences) {
                const keys = el('kbd', '', shortcutLabel(sequence)); keys.dir = 'ltr';
                keys.setAttribute('aria-label', keys.textContent!.replaceAll('␣', t('shortcuts.space')));
                value.append(keys);
            }
            rows.append(row);
        }
        if (rows.childElementCount) hint.append(icon('Keyboard'), rows);
        else hint.hidden = true;
        return hint;
    }
    function screenshot(src: string, alt: string, width: number, height: number) {
        const image = el('img', 'howto-screenshot');
        image.src = src; image.alt = alt; image.width = width; image.height = height;
        image.loading = 'lazy'; image.decoding = 'async';
        return image;
    }
    function page(target: number) {
        const info = pages[target], section = el('section', 'howto-page'); section.dataset.page = String(target);
        const copy = el('div', 'howto-copy');
        const heading = el('h3', '', 'heading' in info ? info.heading : info.title);
        heading.id = `howto-heading-${target}`; section.setAttribute('aria-labelledby', heading.id);
        copy.append(heading);
        if (target !== 0 && info.body) copy.append(el('p', '', info.body));
        if (target === 0) {
            section.classList.add('howto-intro');
            const points = el('ul', 'howto-intro-points');
            for (const text of [info.body, t('howto.introPersistent'), t('howto.introMinimal'), t('howto.introOpenSource')]) points.append(el('li', '', text));
            copy.append(points);
            const art = el('div', 'howto-brand'), logo = el('img');
            logo.src = document.documentElement.dataset.theme === 'light' ? logoLight : logoDark;
            logo.alt = t('app.tuxee'); logo.width = logo.height = 512; art.append(logo);
            const links = el('div', 'howto-chapters');
            pages.slice(1).forEach((item, n) => {
                const link = button(item.title, item.icon, () => show(n + 1)); link.append(el('span', '', item.title)); links.append(link);
            });
            copy.append(links); section.append(art, copy);
        } else if (target === 1) {
            const components = el('div', 'howto-components');
            components.append(el('p', '', t('howto.desktopAddBody')));
            for (const [glyph, label] of [['SquareTerminal', t('app.terminals')], ['FolderPlus', t('common.files')]] as const) {
                const item = el('span'); item.append(icon(glyph), el('span', '', label)); components.append(item);
            }
            copy.append(components);
            const settings = el('section', 'howto-desktop-settings'), settingsCopy = el('div', 'howto-detail');
            settingsCopy.append(el('h4', '', t('howto.desktopSettingsTitle')), el('p', '', t('howto.desktopSettingsBody')), shortcuts('desktop.add', 'desktop.close'));
            settings.append(settingsCopy, screenshot(desktopMenuImage, t('howto.desktopMenuScreenshot'), 514, 438));
            const auto = el('section', 'howto-detail howto-desktop-auto'), autoBody = el('p');
            const autoControl = el('span', 'howto-inline-control');
            autoControl.append(icon('LayoutPanelTop'), el('span', '', t('app.autoLayout')));
            t('howto.desktopAutoLayoutBody', { button: '\uFFFC' }).split('\uFFFC').forEach((part, index) => {
                if (index) autoBody.append(autoControl.cloneNode(true));
                autoBody.append(part);
            });
            auto.append(el('h4', '', t('app.autoLayout')), autoBody, shortcuts('panel.layout'));
            const composition = el('section', 'howto-detail howto-desktop-arrangement');
            const [columns, rows] = dimensions(1, 0), [portraitColumns, portraitRows] = dimensions(0, 1);
            composition.append(el('h4', '', t('howto.desktopCompositionTitle')), el('p', '', t('howto.desktopCompositionBody', { columns, rows, portraitColumns, portraitRows, maxPanels: columns * rows })));
            composition.append(el('p', '', t('howto.desktopMoveBody')));
            section.append(copy, screenshot(desktopImage, t('howto.desktopScreenshot'), 1556, 1022),
                shortcuts('desktop.previous', 'desktop.next', 'panel.previous', 'panel.next'), composition,
                screenshot(desktopLayoutImage, t('howto.desktopLayoutScreenshot'), 1832, 985),
                shortcuts('panel.terminal', 'panel.files', 'panel.close'), auto, settings);
        } else if (target === 2) {
            section.classList.add('howto-terminals');
            section.append(copy, screenshot(terminalImage, t('app.terminals'), 1364, 822),
                shortcuts('panel.terminal', 'panel.close'));
            const archive = el('section', 'howto-detail howto-terminal-archive');
            archive.append(el('h4', '', t('term.postMortem')),
                el('p', '', t('howto.terminalArchiveBody', { state: t('term.postMortem') })),
                screenshot(terminalArchiveImage, t('term.postMortem'), 1368, 836));
            const retained = el('section', 'howto-terminal-pair howto-terminal-retained'), retainedCopy = el('div', 'howto-detail');
            retainedCopy.append(el('p', '', t('howto.terminalRetainedBody', { retained: t('app.retainedTerminals') })), shortcuts('app.retained'));
            retained.append(retainedCopy, screenshot(terminalRetainedImage, t('app.retainedTerminals'), 674, 626));
            const drawer = el('section', 'howto-terminal-pair howto-terminal-drawer'), drawerCopy = el('div', 'howto-detail'), drawerTitle = el('h4');
            drawerTitle.append(icon('TextCursorInput'), el('span', '', t('term.terminalInputDrawer')));
            const drawerHint = el('aside', 'howto-shortcuts');
            drawerHint.append(icon('Keyboard'), el('span', '', t('term.enterSendCtrlEnterInsertShiftEnterNewLine')));
            drawerCopy.append(drawerTitle, el('p', '', t('howto.terminalDrawerBody')), drawerHint);
            drawer.append(drawerCopy, screenshot(terminalDrawerImage, t('term.terminalInputDrawer'), 682, 822));
            const text = el('section', 'howto-terminal-pair howto-terminal-text'), textCopy = el('div', 'howto-detail'), textTitle = el('h4');
            textTitle.append(el('span', 'howto-text-control', t('term.t')), el('span', '', t('term.terminalContentsAsText')));
            textCopy.append(textTitle, el('p', '', t('howto.terminalTextBody', { button: t('term.t') })));
            text.append(textCopy, screenshot(terminalTextImage, t('term.terminalContentsAsText'), 680, 820));
            const files = el('section', 'howto-detail howto-terminal-files');
            files.append(el('h4', '', t('howto.terminalFilesTitle')),
                el('p', '', t('howto.terminalFilesBody', { directory: '~/uploads' })),
                screenshot(terminalFilesImage, t('howto.terminalFilesTitle'), 1360, 824), shortcuts('panel.files'));
            const settings = el('section', 'howto-detail howto-terminal-settings'), settingsTitle = el('h4');
            settingsTitle.append(icon('Settings'), el('span', '', t('app.settings')));
            settings.append(settingsTitle, el('p', '', t('howto.terminalSettingsBody')), shortcuts('app.settings'));
            section.append(archive, retained, drawer, text, files, settings);
        } else if (target === 3) {
            section.classList.add('howto-files');
            const primary = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control';
            const modifier = shortcutLabel([primary]);
            const keyHints = (...items: [string, string][]) => {
                const hint = el('aside', 'howto-shortcuts'), table = el('table');
                hint.setAttribute('aria-label', t('shortcuts.title'));
                for (const [label, key] of items) {
                    const row = el('tr', 'howto-shortcut'), name = el('th', '', label), value = el('td');
                    name.scope = 'row';
                    const keys = el('kbd', '', key); keys.dir = 'ltr';
                    value.append(keys); row.append(name, value); table.append(row);
                }
                hint.append(icon('Keyboard'), table); return hint;
            };
            const transfers = el('section', 'howto-detail howto-files-transfers');
            transfers.append(el('h4', '', t('howto.filesTransfersTitle')),
                el('p', '', t('howto.filesTransfersBody', { modifier: shortcutLabel(['Control']) })),
                screenshot(filesTransferImage, t('howto.filesTransfersTitle'), 1100, 538),
                keyHints([t('howto.filesNavigate'), ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].map(key => shortcutLabel([key])).join(' ')],
                    [t('common.rename'), shortcutLabel(['F2'])], [t('files.open'), shortcutLabel(['Enter'])]));
            const actions = el('section', 'howto-files-pair'), actionsCopy = el('div', 'howto-detail');
            actionsCopy.append(el('h4', '', t('howto.filesActionsTitle')),
                el('p', '', t('howto.filesActionsBody', { modifier })),
                keyHints([t('howto.filesToggleSelection'), t('howto.modifiedClick', { modifier })],
                    [t('howto.filesSelectRange'), t('howto.modifiedClick', { modifier: shortcutLabel(['Shift']) })],
                    [t('files.selectAllVisibleFiles'), shortcutLabel([`${primary}+KeyA`])]));
            actions.append(actionsCopy, screenshot(filesMenuImage, t('files.fileActions'), 545, 548));
            const editor = el('section', 'howto-files-pair howto-files-editor'), editorCopy = el('div', 'howto-detail');
            editorCopy.append(el('h4', '', t('howto.filesEditorTitle')), el('p', '', t('howto.filesEditorBody')),
                keyHints([t('editor.searchReplace'), shortcutLabel([`${primary}+KeyF`])], [t('editor.saveFile'), shortcutLabel([`${primary}+KeyS`])]));
            editor.append(editorCopy, screenshot(filesEditorImage, t('howto.filesEditorTitle'), 545, 538));
            const terminalFiles = el('section', 'howto-detail howto-files-terminal'), pinTitle = el('h4');
            pinTitle.append(icon('Pin'), el('span', '', t('files.pinCurrentFolder')));
            terminalFiles.append(el('h4', '', t('howto.filesTerminalTitle')),
                el('p', '', t('howto.filesTerminalBody', { modifier })),
                screenshot(filesTerminalImage, t('howto.filesTerminalTitle'), 1356, 820),
                pinTitle, el('p', '', t('howto.filesPinBody')));
            section.append(copy, shortcuts('panel.files'), transfers, actions, editor, terminalFiles);
        } else if (target === 4) {
            section.classList.add('howto-gui');
            const launch = el('section', 'howto-detail howto-gui-launch');
            launch.append(el('h4', '', t('howto.guiLaunchTitle')), el('p', '', t('howto.guiLaunchBody')));
            for (const [label, command] of [
                [t('howto.guiInstall'), 'apt install chromium'],
                [t('howto.guiRun'), 'chromium'],
                [t('howto.guiRoot'), 'chromium --no-sandbox'],
            ]) {
                const example = el('div', 'howto-command'), code = el('pre'); code.dir = 'ltr';
                code.append(el('code', '', command)); example.append(el('p', '', label), code); launch.append(example);
            }
            launch.append(shortcuts('panel.terminal'));
            const tabs = el('section', 'howto-detail howto-gui-tabs'), commands = el('pre', 'howto-command'); commands.dir = 'ltr';
            commands.append(el('code', '', 'gimp &\nchromium --no-sandbox &'));
            tabs.append(el('h4', '', t('howto.guiTabsTitle')), el('p', '', t('howto.guiTabsBody')), commands,
                screenshot(guiTerminalImage, t('howto.guiTerminalScreenshot'), 1350, 258));
            const local = el('section', 'howto-detail howto-gui-local');
            local.append(el('h4', '', t('howto.guiLocalTitle')), el('p', '', t('howto.guiLocalBody')));
            const persistent = el('section', 'howto-detail howto-gui-persistent');
            persistent.append(el('h4', '', t('howto.guiPersistentTitle')), el('p', '', t('howto.guiPersistentBody')));
            const audio = el('section', 'howto-detail howto-gui-audio'), audioTitle = el('h4');
            audioTitle.append(icon('Volume2'), el('span', '', t('audio.audio')));
            audio.append(audioTitle, el('p', '', t('howto.guiAudioBody')), shortcuts('audio.mute', 'audio.up', 'audio.down'));
            section.append(copy, screenshot(guiBrowserImage, t('howto.guiScreenshot'), 2000, 1271), launch, tabs, local, persistent, audio);
        } else if (target === 5) {
            const customization = el('section', 'howto-detail howto-tip-customization');
            customization.append(el('h4', '', t('howto.customizationTitle')),
                el('p', '', t('howto.customizationBody')),
                screenshot(customizationImage, t('howto.customizationScreenshot'), 1086, 242), shortcuts('app.settings'));
            const processes = el('section', 'howto-tip-processes'), processesCopy = el('div', 'howto-detail');
            processesCopy.append(el('h4', '', t('howto.processManagerTitle')),
                el('p', '', t('howto.processManagerBody', { processes: t('monitor.processes'), monitor: t('app.resourceMonitor') })), shortcuts('app.monitor'));
            processes.append(processesCopy, screenshot(processesImage, t('howto.processManagerScreenshot'), 1834, 1624));
            const updates = el('section', 'howto-tip-updates'), updatesCopy = el('div', 'howto-detail');
            updatesCopy.append(el('h4', '', t('howto.updatesTitle')),
                el('p', '', t('howto.updatesBody', { about: t('app.about') })), shortcuts('app.about'));
            updates.append(updatesCopy, screenshot(updatesImage, t('howto.updatesScreenshot'), 1036, 1128));
            const keyboard = el('section', 'howto-detail howto-tip-shortcuts'), keyboardBody = el('p');
            const shortcutControl = el('span', 'howto-inline-control');
            shortcutControl.append(icon('Keyboard'), el('span', '', t('shortcuts.title')));
            t('howto.keyboardShortcutsBody', { button: '\uFFFC' }).split('\uFFFC').forEach((part, index) => {
                if (index) keyboardBody.append(shortcutControl.cloneNode(true));
                keyboardBody.append(part);
            });
            keyboard.append(el('h4', '', t('howto.keyboardShortcutsTitle')), keyboardBody, shortcuts('app.shortcuts'));
            section.append(copy, customization, processes, updates, keyboard);
        }
        return section;
    }
    function settle() {
        animation?.cancel(); animation = undefined;
        for (const child of [...track.children]) if (child !== active) child.remove();
        active.style.left = '0';
    }
    function show(target: number) {
        if (target < 0 || target >= pages.length || target === index && active) return;
        if (active) settle();
        const focus = document.activeElement;
        const outgoing = active, direction = Math.sign(target - index) * (document.documentElement.dir === 'rtl' ? -1 : 1);
        index = target; active = page(target); track.append(active);
        dialog.dataset.page = String(target);
        const { previous, next, dots } = pagination;
        const before = pages[Math.max(0, index - 1)].title, after = pages[Math.min(pages.length - 1, index + 1)].title;
        previous.replaceChildren(icon('ArrowLeft'), el('span', '', before)); previous.disabled = index === 0;
        previous.title = before; previous.setAttribute('aria-label', before);
        next.replaceChildren(el('span', '', after), icon('ArrowRight')); next.disabled = index === pages.length - 1;
        next.title = after; next.setAttribute('aria-label', after);
        dots.forEach((dot, n) => { if (n === index) dot.setAttribute('aria-current', 'step'); else dot.removeAttribute('aria-current'); });
        if (outgoing?.contains(focus) || focus instanceof HTMLButtonElement && focus.disabled) dots[index].focus({ preventScroll: true });
        status.textContent = pages[index].title;
        if (outgoing && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
            outgoing.inert = true; active.style.left = `${direction * 100}%`;
            animation = track.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-direction * 100}%)` }], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
            const current = animation; current.finished.then(() => { if (animation === current) settle(); }).catch(() => {});
        } else settle();
    }
    const status = el('span', 'howto-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const pagination = navigation();
    content.append(viewport, status);
    const { dialog } = modal(t('howto.title'), content); dialog.classList.add('howto-modal');
    dialog.querySelector('.modal-head h2')!.replaceWith(pagination.nav);
    dialog.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
        let target: number;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') target = index + (event.key === 'ArrowRight' ? 1 : -1) * (document.documentElement.dir === 'rtl' ? -1 : 1);
        else if (['Home', 'End'].includes(event.key) && (event.target as Element).closest('.howto-page')) return;
        else if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = pages.length - 1;
        else return;
        event.preventDefault(); event.stopPropagation(); show(target);
    });
    dialog.addEventListener('close', () => animation?.cancel(), { once: true });
    show(0);
    return dialog;
}
