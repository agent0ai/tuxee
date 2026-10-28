import { t } from './i18n';
import { button, el } from './ui';
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
    const check = (label: string, checked: boolean) => {
        const wrapper = el('label'), input = el('input'); input.type = 'checkbox'; input.checked = checked;
        wrapper.append(input, document.createTextNode(label)); return { wrapper, input };
    };
    const matchCase = check(t('editor.matchCase'), query.caseSensitive), regex = check(t('editor.regex'), query.regexp);
    const previous = button(t('editor.previousMatch'), 'ChevronLeft', () => findPrevious(view));
    const next = button(t('editor.nextMatch'), 'ChevronRight', () => findNext(view));
    const current = button(t('editor.replaceCurrent'), undefined, () => replaceNext(view));
    const all = button(t('editor.replaceAll'), undefined, () => replaceAll(view));
    const close = button(t('common.close'), 'X', () => closeSearchPanel(view));
    const status = el('span', 'editor-search-status'); status.setAttribute('aria-live', 'polite');
    status.dir = 'ltr';
    const error = el('span', 'editor-search-error', t('editor.invalidRegex')); error.setAttribute('aria-live', 'polite');
    const warning = el('div', 'editor-search-warning', t('editor.searchCurrentPage'));
    warning.hidden = !multipage();
    const fields = el('div', 'editor-search-fields'), actions = el('div', 'editor-search-actions');
    const navigation = el('div', 'editor-search-navigation'); navigation.append(previous, status, next);
    fields.append(find, replace); actions.append(navigation, current, all, matchCase.wrapper, regex.wrapper, error, close);
    dom.append(fields, actions, warning);
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
        error.hidden = !lastQuery.search || lastQuery.valid;
        find.setAttribute('aria-invalid', String(!!lastQuery.search && !lastQuery.valid));
        previous.disabled = next.disabled = current.disabled = all.disabled = !count || view.state.readOnly;
    }
    function commit() {
        const nextQuery = new SearchQuery({ search: find.value, replace: replace.value, caseSensitive: matchCase.input.checked, regexp: regex.input.checked, literal: true });
        if (nextQuery.eq(lastQuery)) return;
        const searchChanged = nextQuery.search !== lastQuery.search || nextQuery.caseSensitive !== lastQuery.caseSensitive || nextQuery.regexp !== lastQuery.regexp;
        const match = searchChanged && nextQuery.valid ? nextQuery.getCursor(view.state).next() : undefined;
        const selection = match && !match.done ? { anchor: match.value.from, head: match.value.to } : undefined;
        lastQuery = nextQuery;
        view.dispatch({ effects: setSearchQuery.of(nextQuery), selection, scrollIntoView: !!selection });
    }
    for (const control of [find, replace, matchCase.input, regex.input]) control.addEventListener('input', commit);
    dom.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearchPanel(view); }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); find.focus(); find.select(); }
        else if (event.key === 'F3' || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
            event.preventDefault(); (event.shiftKey ? findPrevious : findNext)(view);
        }
    });
    return {
        dom, top: true,
        mount() { refresh(); find.focus(); find.select(); },
        update(update) {
            const nextQuery = getSearchQuery(update.state);
            if (!nextQuery.eq(lastQuery)) { lastQuery = nextQuery; find.value = nextQuery.search; replace.value = nextQuery.replace; matchCase.input.checked = nextQuery.caseSensitive; regex.input.checked = nextQuery.regexp; }
            if (update.docChanged || update.selectionSet || update.startState.readOnly !== update.state.readOnly || update.transactions.some(tr => tr.effects.some(effect => effect.is(setSearchQuery)))) refresh();
        },
    };
}
