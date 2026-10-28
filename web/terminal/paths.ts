import type { ILink, Terminal } from '@xterm/xterm';
import { t } from '../i18n';

type Candidate = { path: string; line?: number; column?: number; range: ILink['range'] };

export function terminalPath(text: string) {
    const suffix = text.match(/:(\d+)(?::(\d+))?$/u);
    const token = suffix ? text.slice(0, -suffix[0].length) : text;
    const quoted = token.length > 1 && (token[0] === '"' && token.at(-1) === '"' || token[0] === "'" && token.at(-1) === "'");
    const path = quoted ? token.slice(1, -1) : token;
    if (path === '/' || /[\0\r\n]/u.test(path) || !/^(?:\/|~\/|\.\.?\/)/u.test(path)) return;
    return { path, line: suffix ? Number(suffix[1]) : undefined, column: suffix?.[2] ? Number(suffix[2]) : undefined };
}

// Map text offsets back to terminal cells, including wide characters and wrapped rows.
export function terminalPaths(term: Terminal, row: number): Candidate[] {
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
        const token = raw.slice(prefix).replace(/[)\]},;!?]+$/u, ''), path = terminalPath(token);
        if (!path) continue;
        const start = match.index! + prefix + (/^["']/u.test(token) ? 1 : 0);
        const end = match.index! + prefix + token.length - 1 - (/["']$/u.test(token) ? 1 : 0);
        if (!cells[start] || !cells[end]) continue;
        result.push({ ...path,
            range: { start: { x: cells[start].x, y: cells[start].y }, end: { x: cells[end].end, y: cells[end].y } } });
    }
    return result;
}

export function installTerminalPaths(term: Terminal, open: (path: string, line?: number, column?: number) => void, signal: AbortSignal) {
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const screen = term.element!.querySelector<HTMLElement>('.xterm-screen')!;
    const links = term.registerLinkProvider({ provideLinks: (row, callback) => callback(terminalPaths(term, row).map(candidate => ({
        range: candidate.range, text: candidate.path, activate: () => {},
        hover: () => { screen.title = t('terminal.openPathHint', { modifier: mac ? 'Cmd' : 'Ctrl' }); },
        leave: () => screen.removeAttribute('title'),
    }))) });
    const overlay = document.createElement('div');
    overlay.className = 'terminal-path-hints';
    overlay.setAttribute('aria-hidden', 'true');
    screen.append(overlay);
    let frame = 0, timer = 0;
    const paint = () => {
        if (timer || frame) return;
        timer = window.setTimeout(() => { timer = 0; frame = requestAnimationFrame(() => {
            frame = 0;
            const buffer = term.buffer.active, top = buffer.viewportY + 1, bottom = top + term.rows - 1;
            const hints: HTMLElement[] = [], seen = new Set<string>();
            let wrapped = 0;
            for (let row = top; row <= bottom; row++) {
                if (row > top && buffer.getLine(row - 1)?.isWrapped && ++wrapped < 64) continue;
                wrapped = 0;
                for (const { range } of terminalPaths(term, row)) {
                    const key = `${range.start.y}:${range.start.x}:${range.end.y}:${range.end.x}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    for (let y = Math.max(top, range.start.y); y <= Math.min(bottom, range.end.y); y++) {
                        const start = y === range.start.y ? range.start.x : 1, end = y === range.end.y ? range.end.x : term.cols;
                        const hint = document.createElement('span'); hint.className = 'terminal-path-hint';
                        Object.assign(hint.style, { left: `${(start - 1) / term.cols * 100}%`, width: `${(end - start + 1) / term.cols * 100}%`, top: `${(y - top) / term.rows * 100}%`, height: `${100 / term.rows}%` });
                        hints.push(hint);
                    }
                }
            }
            overlay.replaceChildren(...hints);
        }); }, 75);
    };
    const renders = [term.onRender(paint), term.onScroll(paint), term.onResize(paint)];
    signal.addEventListener('abort', () => { clearTimeout(timer); cancelAnimationFrame(frame); renders.forEach(event => event.dispose()); links.dispose(); overlay.remove(); }, { once: true });
    paint();
    const at = (event: PointerEvent) => {
        const bounds = screen.getBoundingClientRect();
        const x = Math.floor((event.clientX - bounds.left) * term.cols / bounds.width) + 1;
        const y = Math.floor((event.clientY - bounds.top) * term.rows / bounds.height) + term.buffer.active.viewportY + 1;
        if (x < 1 || x > term.cols || y <= term.buffer.active.viewportY || y > term.buffer.active.viewportY + term.rows) return;
        return terminalPaths(term, y).find(({ range }) => (y > range.start.y || y === range.start.y && x >= range.start.x) && (y < range.end.y || y === range.end.y && x <= range.end.x));
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
            if (end && end.path === path.path && end.range.start.x === path.range.start.x && end.range.start.y === path.range.start.y)
                open(end.path, end.line, end.column);
        }, options);
        window.addEventListener('pointercancel', cancel, options);
        window.addEventListener('blur', cancel, options);
    }, { capture: true, signal });
}
