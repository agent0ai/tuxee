import { t } from './i18n';
import { button, el, modal, notify } from './ui';

export type ShortcutBindings = Record<string, [string[], string[]]>;
const maxSteps = 3;
export const shortcutActions = [
    { id: 'desktop.previous', label: () => t('shortcuts.previousDesktop'), group: 'app.workspaces', key: 'ArrowLeft' },
    { id: 'desktop.next', label: () => t('shortcuts.nextDesktop'), group: 'app.workspaces', key: 'ArrowRight' },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `desktop.${i + 1}`, label: () => t('app.workspaceNumber', { count: i + 1 }), group: 'app.workspaces', key: `Digit${(i + 1) % 10}` })),
    { id: 'desktop.add', label: () => t('app.newWorkspace'), group: 'app.workspaces', key: 'KeyD' },
    { id: 'desktop.close', label: () => t('app.closeWorkspace'), group: 'app.workspaces', key: 'KeyC' },
    { id: 'panel.next', label: () => t('shortcuts.nextWindow'), group: 'shortcuts.windows', key: 'ArrowDown' },
    { id: 'panel.previous', label: () => t('shortcuts.previousWindow'), group: 'shortcuts.windows', key: 'ArrowUp' },
    { id: 'panel.terminal', label: () => t('app.addTerminal'), group: 'shortcuts.windows', key: 'Enter' },
    { id: 'panel.files', label: () => t('app.addFileBrowser'), group: 'shortcuts.windows', key: 'KeyF' },
    { id: 'panel.close', label: () => t('app.closePanel'), group: 'shortcuts.windows', key: 'KeyW' },
    { id: 'panel.layout', label: () => t('app.autoLayout'), group: 'shortcuts.windows', key: 'KeyA' },
    { id: 'audio.mute', label: () => t('shortcuts.toggleMute'), group: 'audio.audio', key: 'KeyV' },
    { id: 'audio.up', label: () => t('shortcuts.volumeUp'), group: 'audio.audio', key: 'PageUp' },
    { id: 'audio.down', label: () => t('shortcuts.volumeDown'), group: 'audio.audio', key: 'PageDown' },
    { id: 'app.monitor', label: () => t('app.resourceMonitor'), group: 'app.tuxee', key: 'KeyM' },
    { id: 'app.about', label: () => t('app.about'), group: 'app.tuxee', key: 'KeyH' },
    { id: 'app.settings', label: () => t('app.settings'), group: 'app.tuxee', key: 'KeyS' },
    { id: 'app.retained', label: () => t('app.retainedTerminals'), group: 'app.tuxee', key: 'KeyR' },
    { id: 'app.shortcuts', label: () => t('shortcuts.title'), group: 'app.tuxee', key: 'KeyK' },
    { id: 'app.restart', label: () => t('app.restartTuxee'), group: 'app.tuxee', key: 'KeyX' },
    { id: 'app.logout', label: () => t('app.logOut'), group: 'app.tuxee', key: 'KeyQ' },
];
export function bindings(saved: ShortcutBindings = {}): ShortcutBindings {
    return Object.fromEntries(shortcutActions.map(action => [action.id, saved[action.id] || [[`Alt+Shift+${action.key}`], []]]));
}
const keyCode = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Arrow(Left|Right|Up|Down)|Space|Tab|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Insert|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;
export function shortcutStroke(event: KeyboardEvent): string | undefined {
    if (event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.getModifierState('AltGraph') || !keyCode.test(event.code)) return;
    return [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.code].filter(Boolean).join('+');
}
export function validStart(stroke: string) { return /^(Control\+|Alt\+|(?:Shift\+)?Meta\+|F(?:[1-9]|1[0-2])$)/.test(stroke); }
const prefix = (a: string[], b: string[]) => a.length <= b.length && a.every((stroke, i) => stroke === b[i]);
export function shortcutConflict(all: ShortcutBindings, sequence: string[], action: string, slot: number) {
    if (!sequence.length) return;
    return shortcutActions.find(candidate => all[candidate.id].some((other, index) =>
        other.length && !(candidate.id === action && index === slot) && (prefix(sequence, other) || prefix(other, sequence))));
}
export function shortcutLabel(sequence: string[], platform = navigator.platform) {
    const mac = /Mac|iPhone|iPad/.test(platform);
    const names: Record<string, string> = { Control: 'Ctrl', Alt: mac ? 'Option' : 'Alt', Meta: mac ? 'Cmd' : /Win/.test(platform) ? 'Win' : 'Super', Space: '␣', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '−', Equal: '=', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
    return sequence.map(stroke => stroke.split('+').map(key => names[key] || key.replace(/^(Key|Digit)/, '')).join('+')).join(' → ');
}

export function installShortcuts(getBindings: () => ShortcutBindings, enabled: () => boolean, run: (action: string) => unknown) {
    let pending: string[] = [], timer: ReturnType<typeof setTimeout> | undefined;
    const consumed = new Set<string>(), running = new Set<string>(), events = new AbortController();
    const hint = el('output', 'shortcut-pending'); hint.dir = 'ltr'; hint.setAttribute('aria-live', 'polite');
    const reset = () => { pending = []; clearTimeout(timer); hint.remove(); };
    const consume = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    window.addEventListener('keydown', event => {
        if (event.repeat && consumed.has(event.code)) { consume(event); return; }
        if (!enabled()) { reset(); return; }
        if (document.querySelector('dialog[open]') || document.querySelector(':popover-open')) {
            reset();
            // Modified Space/Enter must not activate a focused confirmation button.
            if (!(event.target as Element).closest('.shortcut-record-modal') && ['Space', 'Enter'].includes(event.code)) {
                const stroke = shortcutStroke(event);
                if (stroke && Object.values(bindings(getBindings())).some(slots => slots.some(sequence => sequence[0] === stroke))) {
                    consume(event); consumed.add(event.code);
                }
            }
            return;
        }
        if (event.code === 'Escape' && pending.length) { consume(event); consumed.add(event.code); reset(); return; }
        const stroke = shortcutStroke(event);
        if (!stroke) { if (event.isComposing || event.getModifierState('AltGraph')) reset(); return; }
        if (event.repeat) return;
        if (!pending.length && !validStart(stroke)) return;
        const sequence = [...pending, stroke];
        const matches = Object.entries(bindings(getBindings())).filter(([, slots]) => slots.some(value => value.length && prefix(sequence, value)));
        if (!matches.length) { reset(); return; }
        consume(event); consumed.add(event.code);
        reset();
        const exact = matches.find(([, slots]) => slots.some(value => value.length === sequence.length && prefix(sequence, value)));
        if (exact) {
            const action = exact[0];
            if (running.has(action)) return;
            running.add(action);
            void Promise.resolve().then(() => run(action)).catch(notify).finally(() => running.delete(action));
        } else {
            pending = sequence; hint.textContent = `${shortcutLabel(pending)} …`; document.body.append(hint);
            timer = setTimeout(reset, 2000);
        }
    }, { capture: true, signal: events.signal });
    window.addEventListener('keyup', event => { if (consumed.delete(event.code)) consume(event); }, { capture: true, signal: events.signal });
    window.addEventListener('blur', () => { reset(); consumed.clear(); }, { signal: events.signal });
    document.addEventListener('pointerdown', reset, { capture: true, signal: events.signal });
    document.addEventListener('visibilitychange', reset, { signal: events.signal });
    return () => { events.abort(); reset(); };
}

export function openShortcuts(getSaved: () => ShortcutBindings | undefined, save: (value: ShortcutBindings) => Promise<void>) {
    const content = el('div'), table = el('table', 'shortcuts-table');
    const head = el('thead'), titles = el('tr');
    titles.append(el('th', '', t('shortcuts.action')), ...[1, 2].map(number => el('th', '', t('shortcuts.binding', { number }))));
    head.append(titles); table.append(head); content.append(table);
    const { dialog } = modal(t('shortcuts.title'), content); dialog.classList.add('shortcuts-modal');
    const render = () => {
        table.querySelectorAll('tbody').forEach(body => body.remove());
        let group = '', body: HTMLTableSectionElement;
        for (const action of shortcutActions) {
            if (action.group !== group) {
                group = action.group; body = el('tbody'); table.append(body);
                const row = el('tr'), title = el('th', 'shortcuts-group', t(group)); title.colSpan = 3; row.append(title); body.append(row);
            }
            const row = el('tr'); row.dataset.shortcut = action.id;
            const name = el('th', '', action.label()); name.scope = 'row'; name.ondblclick = () => record(action.id, 0);
            row.append(name);
            bindings(getSaved())[action.id].forEach((sequence, slot) => {
                const cell = el('td'), control = button(`${action.label()} · ${t('shortcuts.binding', { number: slot + 1 })}`, undefined, () => record(action.id, slot));
                control.textContent = shortcutLabel(sequence) || '—'; control.dir = 'ltr'; control.dataset.slot = String(slot);
                const description = shortcutLabel(sequence).replaceAll('␣', t('shortcuts.space')) || t('shortcuts.unassigned');
                control.setAttribute('aria-description', description); control.title += `: ${description}`;
                cell.append(control); row.append(cell);
            });
            body!.append(row);
        }
    };
    const record = (action: string, slot: number) => {
        let sequence: string[] = [], saving = false, recorded = false;
        const form = el('div', 'shortcut-recorder'), output = el('output', 'shortcut-recording'), status = el('p', 'muted');
        output.dir = 'ltr'; output.tabIndex = 0; output.setAttribute('aria-live', 'polite');
        const title = shortcutActions.find(item => item.id === action)!.label();
        form.append(el('p', '', `${title} · ${t('shortcuts.binding', { number: slot + 1 })}`), output, status);
        const controls = el('div', 'actions');
        const confirm = button(t('common.save'), undefined, async () => {
            if (saving || confirm.disabled) return;
            saving = true; confirm.disabled = true;
            const value = { ...getSaved(), [action]: bindings(getSaved())[action].map((value, index) => index === slot ? sequence : value) as [string[], string[]] };
            try {
                await save(value); popup.close(); render();
                table.querySelector<HTMLButtonElement>(`[data-shortcut="${action}"] [data-slot="${slot}"]`)?.focus();
            }
            catch (error) { notify(error, form); }
            finally { saving = false; update(); }
        }, 'primary');
        const clear = button(t('shortcuts.clear'), undefined, () => { sequence = []; recorded = true; update(); output.focus(); });
        const reset = button(t('common.reset'), undefined, () => { sequence = bindings()[action][slot]; recorded = true; update(); output.focus(); });
        controls.append(clear, reset, button(t('common.cancel'), undefined, () => { if (!saving) popup.close(); }), confirm); form.append(controls);
        const popup = modal(t('shortcuts.record'), form); popup.dialog.classList.add('shortcut-record-modal');
        const update = () => {
            const conflict = shortcutConflict(bindings(getSaved()), sequence, action, slot);
            output.textContent = shortcutLabel(sequence) || t(recorded ? 'shortcuts.unassigned' : 'shortcuts.pressKeys');
            output.setAttribute('aria-label', output.textContent.replaceAll('␣', t('shortcuts.space')));
            status.textContent = conflict ? t('shortcuts.conflict', { action: conflict.label() }) : t('shortcuts.recordHint', { max: maxSteps });
            confirm.disabled = saving || !recorded || !!conflict;
            clear.disabled = reset.disabled = saving;
        };
        // Capture on the dialog so the recorder cannot leak keys to a terminal or the app matcher.
        popup.dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape' || event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
            if (event.target !== output && !event.ctrlKey && !event.altKey && !event.metaKey) return;
            event.preventDefault(); event.stopImmediatePropagation();
            if (saving || event.repeat) return;
            const stroke = shortcutStroke(event);
            if (!stroke) return;
            if (!sequence.length && !validStart(stroke)) { status.textContent = t('shortcuts.modifierRequired'); return; }
            if (sequence.length >= maxSteps) return;
            sequence.push(stroke); recorded = true; update();
        }, { capture: true });
        popup.dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
        update(); output.focus();
    };
    render();
}
