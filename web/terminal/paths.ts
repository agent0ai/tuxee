import type { ILink, Terminal } from '@xterm/xterm';
import { t } from '../i18n';
import { replaceTerminalOscLinks } from './state';

type Target = NonNullable<ReturnType<typeof terminalLink>>;
type Candidate = Target & { text: string; range: ILink['range'] };

export function terminalPath(text: string, hostname = '') {
    const suffix = text.match(/:(\d+)(?::(\d+))?$/u);
    const token = suffix ? text.slice(0, -suffix[0].length) : text;
    const quoted = token.length > 1 && (token[0] === '"' && token.at(-1) === '"' || token[0] === "'" && token.at(-1) === "'");
    let path = quoted ? token.slice(1, -1) : token;
    if (/^file:\/\//iu.test(path)) {
        try {
            if (/[\x00-\x1f\x7f\\]/u.test(path)) return;
            const url = new URL(path);
            if (!['', 'localhost', hostname.toLowerCase()].includes(url.hostname.toLowerCase()) || url.search || url.hash) return;
            path = decodeURIComponent(url.pathname);
        } catch { return; }
    }
    if (path === '/' || /[\0\r\n]/u.test(path) || !/^(?:\/|~\/|\.\.?\/)/u.test(path)) return;
    return { path, line: suffix ? Number(suffix[1]) : undefined, column: suffix?.[2] ? Number(suffix[2]) : undefined };
}

export function terminalLink(text: string, hostname = '') {
    const token = /^(".*"|'.*')$/u.test(text) ? text.slice(1, -1) : text;
    if (/^https?:\/\//iu.test(token)) {
        try {
            if (/[\s\x00-\x1f\x7f\\]/u.test(token) || !/^https?:\/\/[^/?#]+/iu.test(token)) return;
            return { url: new URL(token).href };
        } catch { return; }
    }
    return terminalPath(text, hostname);
}

// Map text offsets back to terminal cells, including wide characters and wrapped rows.
export function terminalLinks(term: Terminal, row: number, hostname = ''): Candidate[] {
    const buffer = term.buffer.active;
    let first = row - 1, last = first;
    if (first < 0 || first >= buffer.length) return [];
    while (first > 0 && buffer.getLine(first)?.isWrapped && row - first < 64) first--;
    while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped && last - first < 64) last++;
    let text = '';
    const cells: { x: number; y: number; end: number }[] = [];
    for (let y = first; y <= last; y++) {
        const line = buffer.getLine(y)!;
        for (let x = 0; x < term.cols; x++) {
            const cell = line.getCell(x)!;
            const width = cell.getWidth();
            if (!width) continue;
            const chars = cell.getChars() || ' ';
            for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: y + 1, end: x + width });
            text += chars;
        }
    }
    const result: Candidate[] = [];
    const tokens = /"[^"\n]+"(?::\d+(?::\d+)?)?|'[^'\n]+'(?::\d+(?::\d+)?)?|[^\s"'<>|]+/gu;
    for (const match of text.matchAll(tokens)) {
        const raw = match[0], prefix = raw.match(/^[([{]+/u)?.[0].length || 0;
        let token = raw.slice(prefix);
        if (/^https?:\/\//iu.test(token)) {
            const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
            const excess: Record<string, number> = { ')': 0, ']': 0, '}': 0 };
            for (const char of token) {
                if (pairs[char]) excess[pairs[char]]--;
                else if (char in excess) excess[char]++;
            }
            let end = token.length;
            while (end && (/[.,;!?]/u.test(token[end - 1]) || excess[token[end - 1]] > 0)) {
                if (token[end - 1] in excess) excess[token[end - 1]]--;
                end--;
            }
            token = token.slice(0, end);
        } else token = token.replace(/[)\]},;!?]+$/u, '');
        const target = terminalLink(token, hostname);
        if (!target) continue;
        const start = match.index! + prefix + (/^["']/u.test(token) ? 1 : 0);
        const end = match.index! + prefix + token.length - 1 - (/["']$/u.test(token) ? 1 : 0);
        if (!cells[start] || !cells[end]) continue;
        result.push({ ...target, text: token,
            range: { start: { x: cells[start].x, y: cells[start].y }, end: { x: cells[end].end, y: cells[end].y } } });
    }
    return result;
}

export function installTerminalLinks(term: Terminal, open: (target: Target) => void, signal: AbortSignal, hostname = '') {
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const screen = term.element!.querySelector<HTMLElement>('.xterm-screen')!;
    const previousHandler = term.options.linkHandler;
    term.options.linkHandler = { allowNonHttpProtocols: true, activate: () => {} };
    const candidates = (row: number): Candidate[] => {
        let embedded: ILink[] = [];
        // The pinned OSC provider supplies its ranges synchronously.
        osc.provideLinks(row, links => { embedded = links || []; });
        const explicit = embedded.flatMap(link => {
            const target = /^(?:https?|file):\/\//iu.test(link.text) ? terminalLink(link.text, hostname) : undefined;
            return target ? [{ ...target, text: link.text, range: link.range }] : [];
        });
        const offset = ({ x, y }: { x: number; y: number }) => y * term.cols + x;
        return [...explicit, ...terminalLinks(term, row, hostname).filter(link => !embedded.some(other =>
            offset(link.range.start) <= offset(other.range.end) && offset(other.range.start) <= offset(link.range.end)))];
    };
    const osc = replaceTerminalOscLinks(term, { provideLinks: (row, callback) => callback(candidates(row).map(candidate => ({
        range: candidate.range, text: candidate.text, activate: () => {},
        hover: () => { screen.title = ('url' in candidate ? `${candidate.url}\n` : '') + t('terminal.openPathHint', { modifier: mac ? 'Cmd' : 'Ctrl' }); },
        leave: () => screen.removeAttribute('title'),
    }))) }, signal);
    signal.addEventListener('abort', () => { term.options.linkHandler = previousHandler; screen.removeAttribute('title'); }, { once: true });
    const at = (event: PointerEvent) => {
        const bounds = screen.getBoundingClientRect();
        const x = Math.floor((event.clientX - bounds.left) * term.cols / bounds.width) + 1;
        const y = Math.floor((event.clientY - bounds.top) * term.rows / bounds.height) + term.buffer.active.viewportY + 1;
        if (x < 1 || x > term.cols || y <= term.buffer.active.viewportY || y > term.buffer.active.viewportY + term.rows) return;
        return candidates(y).find(({ range }) => (y > range.start.y || y === range.start.y && x >= range.start.x) && (y < range.end.y || y === range.end.y && x <= range.end.x));
    };
    let cancel = () => {};
    signal.addEventListener('abort', () => cancel(), { once: true });
    term.element!.addEventListener('pointerdown', event => {
        cancel();
        const touch = event.pointerType === 'touch';
        if (!event.isPrimary || event.button !== 0 || event.altKey || event.shiftKey ||
            (touch ? term.modes.mouseTrackingMode !== 'none' : !(mac ? event.metaKey : event.ctrlKey))) return;
        const path = at(event);
        if (!path) return;
        const press = new AbortController(), options = { capture: true, signal: press.signal };
        const started = performance.now();
        let moved = false, cleanup = 0;
        cancel = () => { clearTimeout(cleanup); press.abort(); };
        const suppress = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
        if (!touch) {
            suppress(event);
            // xterm reports mouse events, not pointer events; consume both halves before it sees them.
            for (const type of ['mousedown', 'mousemove', 'mouseup', 'click']) window.addEventListener(type, suppress, options);
        }
        window.addEventListener('pointermove', move => {
            if (move.pointerId === event.pointerId && Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) > 6) moved = true;
        }, options);
        window.addEventListener('pointerdown', () => { moved = true; }, options);
        window.addEventListener('keydown', key => { if (key.key === 'Escape') moved = true; }, options);
        window.addEventListener('pointerup', up => {
            if (up.pointerId !== event.pointerId) return;
            if (!touch) suppress(up);
            // Keep compatibility mouseup/click suppressed through the end of this event dispatch.
            cleanup = window.setTimeout(cancel, 0);
            if (moved || performance.now() - started > 500 || touch && term.hasSelection() ||
                !touch && !(mac ? up.metaKey : up.ctrlKey)) return;
            const end = at(up);
            if (end && end.text === path.text && end.range.start.x === path.range.start.x && end.range.start.y === path.range.start.y)
                open(end);
        }, options);
        window.addEventListener('pointercancel', cancel, options);
        window.addEventListener('blur', cancel, options);
    }, { capture: true, signal });
}
