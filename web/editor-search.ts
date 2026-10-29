import { t } from './i18n';
import { button, el, popover, scopeNotifications } from './ui';
import { fittingHeaderItemCount } from './overflow';
import { SearchQuery, setSearchQuery, getSearchQuery, openSearchPanel, closeSearchPanel, findNext, findPrevious, replaceNext, replaceAll } from './vendor/code-editor/library.js';

export const editorSearchKeymap = [
    { key: 'Mod-f', run: openSearchPanel, preventDefault: true },
    { key: 'F3', run: findNext, shift: findPrevious, preventDefault: true },
    { key: 'Mod-g', run: findNext, shift: findPrevious, preventDefault: true },
];

export function editorSearchPanel(view, multipage: () => boolean) {
    const dom = el('div', 'editor-search');
    const find = el('textarea'), replace = el('textarea');
    const query = getSearchQuery(view.state);
    find.value = query.search; replace.value = query.replace;
    find.rows = replace.rows = 2;
    find.dir = replace.dir = 'ltr';
    find.setAttribute('aria-label', t('editor.findText')); find.placeholder = t('editor.findText');
    replace.setAttribute('aria-label', t('editor.replaceText')); replace.placeholder = t('editor.replaceText');
    find.setAttribute('main-field', 'true');
    const toggle = (label: string, name: 'CaseSensitive' | 'Regex', pressed: boolean) => {
        const control = button(label, name, () => {
            control.setAttribute('aria-pressed', String(control.getAttribute('aria-pressed') !== 'true'));
            commit();
        });
        control.setAttribute('aria-pressed', String(pressed));
        return control;
    };
    const matchCase = toggle(t('editor.matchCase'), 'CaseSensitive', query.caseSensitive), regex = toggle(t('editor.regex'), 'Regex', query.regexp);
    const previous = button(t('editor.previousMatch'), 'ChevronLeft', () => findPrevious(view));
    const next = button(t('editor.nextMatch'), 'ChevronRight', () => findNext(view));
    const current = button(t('editor.replaceCurrent'), undefined, () => replaceNext(view));
    const all = button(t('editor.replaceAll'), undefined, () => replaceAll(view));
    const close = button(t('common.close'), 'X', () => closeSearchPanel(view), 'editor-search-close');
    const status = el('span', 'editor-search-status'); status.setAttribute('aria-live', 'polite');
    status.dir = 'ltr';
    const error = el('div', 'editor-search-error', t('editor.invalidRegex')); error.setAttribute('aria-live', 'polite');
    const warning = el('div', 'editor-search-warning', t('editor.searchCurrentPage'));
    warning.hidden = !multipage();
    const fields = el('div', 'editor-search-fields'), actions = el('div', 'editor-search-actions');
    const navigation = el('div', 'editor-search-navigation'); navigation.append(previous, status, next);
    const controls = el('div', 'editor-search-controls'), items = [navigation, current, all, matchCase, regex];
    let overflow: HTMLElement[] = [], closeMenu = () => {}, frame = 0;
    const more = button(t('editor.searchReplace'), 'Ellipsis', () => {
        const content = el('div', 'menu-actions editor-search-menu');
        content.setAttribute('role', 'dialog'); content.setAttribute('aria-label', more.title);
        scopeNotifications(content, dom);
        for (const item of overflow) {
            const group = item === navigation ? el('div', 'editor-search-navigation') : content;
            for (const source of item === navigation ? [...item.children] : [item]) {
                if (!(source instanceof HTMLButtonElement)) { group.append(source.cloneNode(true)); continue; }
                const action = button(source.title, undefined, () => { closeMenu(); source.click(); });
                action.replaceChildren(...[...source.childNodes].map(node => node.cloneNode(true)));
                if (group === content && source.firstElementChild) action.append(el('span', '', source.title));
                action.disabled = source.disabled;
                if (source.hasAttribute('aria-pressed')) {
                    action.setAttribute('aria-pressed', source.getAttribute('aria-pressed')!);
                    action.classList.toggle('active', source.classList.contains('active'));
                }
                group.append(action);
            }
            if (group !== content) content.append(group);
        }
        ({ close: closeMenu } = popover(more, content));
    }, 'editor-search-more');
    more.setAttribute('aria-haspopup', 'dialog'); more.setAttribute('aria-expanded', 'false');
    controls.append(...items, more);
    fields.append(find, replace); actions.append(controls, close);
    dom.append(fields, actions, error, warning);
    function fit() {
        if (!controls.getClientRects().length) return;
        closeMenu();
        items.forEach(item => { item.hidden = false; }); more.hidden = false;
        const gap = parseFloat(getComputedStyle(controls).columnGap) || 0;
        const count = fittingHeaderItemCount(items.map(item => item.getBoundingClientRect().width), controls.clientWidth, more.offsetWidth, gap);
        overflow = items.slice(count);
        for (const item of overflow) {
            if (item.contains(document.activeElement)) more.focus({ preventScroll: true });
            item.hidden = true;
        }
        more.hidden = !overflow.length;
        if (more.hidden && document.activeElement === more) find.focus({ preventScroll: true });
    }
    const scheduleFit = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    const resize = new ResizeObserver(scheduleFit);
    let lastQuery = query;
    function refresh() {
        let count = 0, position = 0;
        const selection = view.state.selection.main;
        if (lastQuery.valid) {
            const cursor = lastQuery.getCursor(view.state);
            while (!cursor.next().done) {
                count++;
                if (cursor.value.from === selection.from && cursor.value.to === selection.to) position = count;
            }
        }
        status.textContent = `${position}/${count}`;
        status.title = t('editor.matches', { count });
        for (const [control, pressed] of [[matchCase, lastQuery.caseSensitive], [regex, lastQuery.regexp]] as const) {
            control.setAttribute('aria-pressed', String(pressed));
            control.classList.toggle('active', pressed);
        }
        error.hidden = !lastQuery.search || lastQuery.valid;
        find.setAttribute('aria-invalid', String(!!lastQuery.search && !lastQuery.valid));
        previous.disabled = next.disabled = current.disabled = all.disabled = !count || view.state.readOnly;
        scheduleFit();
    }
    function commit() {
        const nextQuery = new SearchQuery({ search: find.value, replace: replace.value, caseSensitive: matchCase.getAttribute('aria-pressed') === 'true', regexp: regex.getAttribute('aria-pressed') === 'true', literal: true });
        if (nextQuery.eq(lastQuery)) return;
        const searchChanged = nextQuery.search !== lastQuery.search || nextQuery.caseSensitive !== lastQuery.caseSensitive || nextQuery.regexp !== lastQuery.regexp;
        const match = searchChanged && nextQuery.valid ? nextQuery.getCursor(view.state).next() : undefined;
        const selection = match && !match.done ? { anchor: match.value.from, head: match.value.to } : undefined;
        lastQuery = nextQuery;
        view.dispatch({ effects: setSearchQuery.of(nextQuery), selection, scrollIntoView: !!selection });
    }
    for (const control of [find, replace]) control.addEventListener('input', commit);
    dom.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearchPanel(view); }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); find.focus(); find.select(); }
        else if (event.key === 'F3' || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
            event.preventDefault(); (event.shiftKey ? findPrevious : findNext)(view);
        }
    });
    return {
        dom, top: true,
        mount() { resize.observe(controls); refresh(); find.focus(); find.select(); },
        destroy() { resize.disconnect(); cancelAnimationFrame(frame); closeMenu(); },
        update(update) {
            const nextQuery = getSearchQuery(update.state);
            if (!nextQuery.eq(lastQuery)) { lastQuery = nextQuery; find.value = nextQuery.search; replace.value = nextQuery.replace; }
            if (update.docChanged || update.selectionSet || update.startState.readOnly !== update.state.readOnly || update.transactions.some(tr => tr.effects.some(effect => effect.is(setSearchQuery)))) refresh();
        },
    };
}
