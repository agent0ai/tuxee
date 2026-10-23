export type Kind = 'files' | 'terminal';
export type Panel = {
    id: string;
    kind: Kind;
    path: string;
    terminal?: string;
    x: number;
    y: number;
    w: number;
    h: number;
};
export type Workspace = {
    id: string;
    name: string;
    columns: number;
    rows: number;
    panels: Panel[];
    active: string;
    layout?: { mode: 1 | 2 | 3; custom: (Rect & { id: string })[] };
};
export type Settings = {
    serverName?: string;
    serverColor?: string;
    uploadConcurrency?: number;
    theme: 'dark' | 'light';
    current: string;
    workspaces: Workspace[];
    monitoring?: MonitoringPreferences;
};
export type MonitoringPreferences = { hidden?: boolean; cpu: boolean; memory: boolean; swap: boolean; disks: string[]; networks: string[]; interval: number };
export type User = {
    name: string;
    home: string;
    uid: number;
    gid: number;
};
export type TerminalInfo = {
    id: string;
    name: string;
    directory: string;
    pid: number;
    exited: boolean;
    attached: number;
};
export type Hooks = {
    changed: (immediate?: boolean) => void | Promise<void>;
    close: () => void;
    openTerminal: (path: string) => void;
    user: User;
    title?: (name: string) => void;
};
export type View = {
    renamePanel?: () => Promise<void>;
    dispose: () => void;
    resize?: () => void;
    canClose?: () => Promise<boolean>;
};
export const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
export const join = (path: string, name: string) => `${path.replace(/\/$/, '')}/${name}`;
export function dimensions(width = innerWidth, height = innerHeight): [number, number] {
    return height > width ? [2, 4] : [4, 2];
}
export function orientWorkspace(ws: Workspace, width = innerWidth, height = innerHeight): boolean {
    const [columns, rows] = dimensions(width, height);
    if (ws.columns === columns && ws.rows === rows) return false;
    for (const rect of [...ws.panels, ...ws.layout?.custom || []]) {
        [rect.x, rect.y, rect.w, rect.h] = [rect.y, rect.x, rect.h, rect.w];
    }
    ws.columns = columns; ws.rows = rows;
    return true;
}
export function newPanel(kind: Kind, path: string): Panel { return { id: id(), kind, path, x: 0, y: 0, w: 1, h: 1 }; }
export function newWorkspace(name: string, home: string, width = innerWidth, height = innerHeight): Workspace {
    const [columns, rows] = dimensions(width, height);
    const panels = [newPanel('files', '/'), newPanel('terminal', home)].map((panel, i) => ({ ...panel, x: columns === 2 ? 0 : i * 2, y: columns === 2 ? i * 2 : 0, w: 2, h: 2 }));
    if (columns === 4 && width >= 1200 && height >= 700) {
        panels[0].h = 1;
        panels.splice(1, 0, { ...newPanel('files', home), x: 0, y: 1, w: 2, h: 1 });
        if (width >= 1920 && height >= 1000) {
            panels[2].h = 1;
            panels.push({ ...newPanel('terminal', home), x: 2, y: 1, w: 2, h: 1 });
        }
    }
    return { id: id(), name, columns, rows, panels, active: panels[0].id };
}
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export function validGrid(ws: Workspace): boolean {
    if (!(ws.columns === 4 && ws.rows === 2 || ws.columns === 2 && ws.rows === 4) || ws.panels.length > 8) return false;
    const cells = new Set<string>();
    return ws.panels.every(p => {
        if (![p.x, p.y, p.w, p.h].every(Number.isInteger) || p.x < 0 || p.y < 0 || p.w < 1 || p.h < 1 || p.x + p.w > ws.columns || p.y + p.h > ws.rows)
            return false;
        for (let y = p.y; y < p.y + p.h; y++)
            for (let x = p.x; x < p.x + p.w; x++) {
                const cell = `${x},${y}`;
                if (cells.has(cell))
                    return false;
                cells.add(cell);
            }
        return true;
    });
}
export function place(ws: Workspace, panel: Panel, rect: Rect): boolean {
    const next = { ...panel, ...rect };
    if (!validGrid({ ...ws, panels: [...ws.panels.filter(p => p.id !== panel.id), next] }))
        return false;
    Object.assign(panel, next);
    if (!ws.panels.includes(panel)) ws.panels.push(panel);
    return true;
}
export function split(ws: Workspace, targetID: string, panel: Panel, edge: Edge): boolean {
    const target = ws.panels.find(p => p.id === targetID);
    if (!target || target === panel)
        return false;
    const horizontal = edge === 'left' || edge === 'right';
    if ((horizontal ? target.w : target.h) < 2)
        return false;
    const half = Math.floor((horizontal ? target.w : target.h) / 2);
    const a = { x: target.x, y: target.y, w: target.w, h: target.h }, b = { ...a };
    if (horizontal) {
        a.w = half;
        b.x += half;
        b.w -= half;
    }
    else {
        a.h = half;
        b.y += half;
        b.h -= half;
    }
    Object.assign(panel, edge === 'left' || edge === 'top' ? a : b);
    Object.assign(target, edge === 'left' || edge === 'top' ? b : a);
    if (!ws.panels.includes(panel))
        ws.panels.push(panel);
    return true;
}
export function addCompact(ws: Workspace, panel: Panel, near?: { x: number; y: number }): boolean {
    if (near) {
        const cells = Array.from({ length: ws.columns * ws.rows }, (_, i) => ({ x: i % ws.columns, y: Math.floor(i / ws.columns), w: 1, h: 1 }));
        cells.sort((a, b) => Math.hypot(a.x + .5 - near.x, a.y + .5 - near.y) - Math.hypot(b.x + .5 - near.x, b.y + .5 - near.y));
        for (const cell of cells) {
            const layout = dropLayout(ws, panel, cell);
            if (!layout) continue;
            for (const next of layout) Object.assign(ws.panels.find(p => p.id === next.id) || panel, next);
            ws.panels.push(panel);
            Object.assign(panel, expandedRect(ws, panel, panel.kind === 'files' ? 1 : ws.columns));
            return true;
        }
        return false;
    }
    // Use existing gaps first, then split the largest panel without moving others.
    let best: Rect | undefined;
    for (let y = 0; y < ws.rows; y++)
        for (let x = 0; x < ws.columns; x++) {
            if (!ws.panels.some(p => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)) {
                const rect = expandedRect(ws, { ...panel, x, y, w: 1, h: 1 }, panel.kind === 'files' ? 1 : ws.columns);
                if (!best || rect.w * rect.h > best.w * best.h) best = rect;
            }
        }
    if (best) return place(ws, panel, best);
    const largest = [...ws.panels].filter(p => p.w > 1 || p.h > 1).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!largest)
        return false;
    return split(ws, largest.id, panel, largest.w >= largest.h && largest.w > 1 ? 'right' : 'bottom');
}

export type Rect = Pick<Panel, 'x' | 'y' | 'w' | 'h'>;
export function gridDrop(ws: Workspace, x: number, y: number, width: number, height: number): Rect | undefined {
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height) return;
    const span = (position: number, length: number, count: number): [number, number] => {
        const cell = length / count, boundary = Math.round(position / cell);
        if (boundary > 0 && boundary < count && Math.abs(position - boundary * cell) <= Math.min(32, cell * .2))
            return [boundary - 1, 2];
        return [Math.floor(position / cell), 1];
    };
    const [left, w] = span(x, width, ws.columns), [top, h] = span(y, height, ws.rows);
    return { x: left, y: top, w, h };
}
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export function dropLayout(ws: Workspace, panel: Panel, rect: Rect): Panel[] | undefined {
    const next = { ...panel, ...rect };
    if (!validGrid({ ...ws, panels: [next] })) return;
    const others = ws.panels.filter(p => p.id !== panel.id);
    const fixed = others.filter(p => !overlaps(p, rect)), blocked = others.filter(p => overlaps(p, rect));
    // Preserve the existing in-place trim whenever every neighbor can remain.
    const trimmed = blocked.map(p => [
            { ...p, w: rect.x - p.x },
            { ...p, x: rect.x + rect.w, w: p.x + p.w - rect.x - rect.w },
            { ...p, h: rect.y - p.y },
            { ...p, y: rect.y + rect.h, h: p.y + p.h - rect.y - rect.h },
        ].filter(r => r.w >= 1 && r.h >= 1).sort((a, b) => b.w * b.h - a.w * a.h)[0]);
    if (trimmed.every(p => p !== undefined)) {
        const panels = [...fixed.map(p => ({ ...p })), ...trimmed, next];
        return validGrid({ ...ws, panels }) ? panels : undefined;
    }
    if (ws.columns * ws.rows - rect.w * rect.h - fixed.reduce((sum, p) => sum + p.w * p.h, 0) < blocked.length) return;
    const mask = (r: Rect) => {
        let bits = 0;
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) bits |= 1 << (y * ws.columns + x);
        return bits;
    };
    const occupied = fixed.reduce((bits, p) => bits | mask(p), mask(rect));
    const choices = blocked.map(p => {
        const options = [];
        for (let y = 0; y < ws.rows; y++) for (let x = 0; x < ws.columns; x++)
            for (let h = 1; h <= p.h && y + h <= ws.rows; h++) for (let w = 1; w <= p.w && x + w <= ws.columns; w++) {
                const candidate = { ...p, x, y, w, h }, bits = mask(candidate);
                if (bits & occupied) continue;
                options.push({ panel: candidate, bits,
                    moved: Number(x < p.x || y < p.y || x + w > p.x + p.w || y + h > p.y + p.h),
                    lost: p.w * p.h - w * h,
                    distance: Math.abs(2 * x + w - 2 * p.x - p.w) + Math.abs(2 * y + h - 2 * p.y - p.h) });
            }
        return options;
    });
    type Plan = { panels: Panel[]; moved: number; lost: number; distance: number };
    const cache = new Map<string, Plan | undefined>();
    // Joint placement on eight cells avoids greedy moves that needlessly shrink another neighbor.
    function arrange(index: number, used: number): Plan | undefined {
        if (index === blocked.length) return { panels: [], moved: 0, lost: 0, distance: 0 };
        const key = `${index}:${used}`;
        if (cache.has(key)) return cache.get(key);
        let best: Plan | undefined;
        for (const option of choices[index]) {
            if (used & option.bits) continue;
            const rest = arrange(index + 1, used | option.bits);
            if (!rest) continue;
            const moved = option.moved + rest.moved, lost = option.lost + rest.lost, distance = option.distance + rest.distance;
            if (!best || moved < best.moved || moved === best.moved && (lost < best.lost || lost === best.lost && distance < best.distance))
                best = { panels: [option.panel, ...rest.panels], moved, lost, distance };
        }
        cache.set(key, best);
        return best;
    }
    const plan = arrange(0, occupied);
    if (!plan) return;
    const panels = [...fixed.map(p => ({ ...p })), ...plan.panels, next];
    return validGrid({ ...ws, panels }) ? panels : undefined;
}
export type Divider = { axis: 'x' | 'y'; at: number; from: number; to: number; before: string[]; after: string[]; min: number; max: number };
export function sharedDividers(ws: Workspace): Divider[] {
    const result: Divider[] = [];
    for (const axis of ['x', 'y'] as const) {
        const size = axis === 'x' ? 'w' : 'h', other = axis === 'x' ? 'y' : 'x', span = axis === 'x' ? 'h' : 'w';
        const segments: Divider[] = [];
        for (const a of ws.panels) for (const b of ws.panels) {
            const at = a[axis] + a[size], from = Math.max(a[other], b[other]), to = Math.min(a[other] + a[span], b[other] + b[span]);
            if (at === b[axis] && from < to) segments.push({ axis, at, from, to, before: [a.id], after: [b.id], min: 0, max: 0 });
        }
        segments.sort((a, b) => a.at - b.at || a.from - b.from);
        const joined: Divider[] = [];
        for (const segment of segments) {
            const previous = joined.at(-1);
            if (previous?.at === segment.at && segment.from <= previous.to) {
                previous.to = Math.max(previous.to, segment.to);
                previous.before = [...new Set([...previous.before, ...segment.before])];
                previous.after = [...new Set([...previous.after, ...segment.after])];
            } else joined.push(segment);
        }
        for (const divider of joined) {
            const before = ws.panels.filter(p => divider.before.includes(p.id)), after = ws.panels.filter(p => divider.after.includes(p.id));
            divider.min = Math.max(...before.map(p => p[axis] + 1));
            divider.max = Math.min(...after.map(p => p[axis] + p[size] - 1));
            const fixed = ws.panels.filter(p => !before.includes(p) && !after.includes(p));
            // A shared edge can extend past its neighbors; respect obstacles along that extension.
            for (const p of before) for (const q of fixed)
                if (p[other] < q[other] + q[span] && p[other] + p[span] > q[other] && q[axis] >= divider.at)
                    divider.max = Math.min(divider.max, q[axis]);
            for (const p of after) for (const q of fixed)
                if (p[other] < q[other] + q[span] && p[other] + p[span] > q[other] && q[axis] + q[size] <= divider.at)
                    divider.min = Math.max(divider.min, q[axis] + q[size]);
        }
        result.push(...joined);
    }
    return result;
}
export function resizeDividers(ws: Workspace, dividers: Divider[], dx: number, dy: number): Panel[] | undefined {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const panels = ws.panels.map(p => ({ ...p }));
    for (const divider of dividers) {
        const axis = divider.axis, size = axis === 'x' ? 'w' : 'h';
        const at = Math.max(divider.min, Math.min(divider.max, divider.at + (axis === 'x' ? dx : dy)));
        for (const p of panels) {
            if (divider.before.includes(p.id)) p[size] = at - p[axis];
            if (divider.after.includes(p.id)) { p[size] += p[axis] - at; p[axis] = at; }
        }
    }
    return panels.some((p, i) => panels.slice(i + 1).some(q => overlaps(p, q))) ? undefined : panels;
}
function expandedRect(ws: Workspace, panel: Panel, maxWidth: number): Rect {
    const others = ws.panels.filter(p => p.id !== panel.id);
    let best: Rect = panel;
    for (let y = 0; y <= panel.y; y++) for (let x = 0; x <= panel.x; x++)
        for (let bottom = panel.y + panel.h; bottom <= ws.rows; bottom++) for (let right = panel.x + panel.w; right <= Math.min(ws.columns, x + maxWidth); right++) {
            const rect = { x, y, w: right - x, h: bottom - y };
            if (rect.w * rect.h > best.w * best.h && !others.some(other => overlaps(rect, other))) best = rect;
        }
    return best;
}
export function expandPanel(ws: Workspace, panel: Panel): Rect {
    const expanded = expandedRect(ws, panel, ws.columns);
    return expanded === panel ? { x: panel.x, y: panel.y, w: 1, h: 1 } : expanded;
}
function automaticWidthCap(ws: Workspace, panel: Panel, width: number, priority?: Kind): number {
    return Math.min(panel.kind === 'files' ? 2 : ws.columns,
        panel.kind === priority ? ws.columns : Math.max(1, Math.floor((panel.kind === 'terminal' ? 1440 : 640) / (width / ws.columns))));
}
export function expandAfterClose(ws: Workspace, closed: Rect, candidates = ws.panels) {
    for (const panel of [...candidates].sort((a, b) => a.w * a.h - b.w * b.h)) {
        let axis: 'x' | 'y';
        if (panel.y < closed.y + closed.h && panel.y + panel.h > closed.y
            && (panel.x + panel.w === closed.x || panel.x === closed.x + closed.w)) axis = 'x';
        else if (panel.x < closed.x + closed.w && panel.x + panel.w > closed.x
            && (panel.y + panel.h === closed.y || panel.y === closed.y + closed.h)) axis = 'y';
        else continue;
        const size = axis === 'x' ? 'w' : 'h', backwards = panel[axis] === closed[axis] + closed[size];
        const maxWidth = Math.max(panel.w, panel.kind === 'files' ? 2 : ws.columns);
        for (let step = 0; step < closed[size]; step++) {
            const rect = { x: panel.x, y: panel.y, w: panel.w, h: panel.h };
            rect[size]++;
            if (backwards) rect[axis]--;
            if (rect.w > maxWidth || !place(ws, panel, rect)) break;
        }
    }
}
export function screenSnap(ws: Workspace, x: number, y: number, width: number, height: number): Rect | undefined {
    const edge = 18, left = x < edge, right = x > width - edge, top = y < edge, bottom = y > height - edge;
    if (x < -edge || y < -edge || x > width + edge || y > height + edge || !left && !right && !top && !bottom) return;
    const halfW = ws.columns / 2, halfH = ws.rows / 2;
    if ((top || bottom) && (left || right || x < width * .3 || x > width * .7)) return { x: x < width / 2 ? 0 : halfW, y: top ? 0 : halfH, w: halfW, h: halfH };
    if (left || right) return { x: left ? 0 : halfW, y: 0, w: halfW, h: ws.rows };
    return { x: 0, y: top ? 0 : halfH, w: ws.columns, h: halfH };
}
export function snapLayout(ws: Workspace, panel: Panel, rect: Rect): Panel[] | undefined {
    const others = ws.panels.filter(p => p.id !== panel.id), fixed = { ...panel, ...rect };
    if (!validGrid({ ...ws, panels: [fixed] }) || others.length > ws.columns * ws.rows - rect.w * rect.h) return;
    let keep = others.filter(p => !overlaps(p, rect));
    if (ws.columns * ws.rows - rect.w * rect.h - keep.reduce((sum, p) => sum + p.w * p.h, 0) < others.length - keep.length) keep = [];
    const moving = others.filter(p => !keep.includes(p)), occupied: Rect[] = [rect, ...keep], spaces: Rect[] = [];
    // Partition the remaining cells into rectangles, then split the largest spaces as needed.
    while (true) {
        let best: Rect | undefined;
        for (let y = 0; y < ws.rows; y++) for (let x = 0; x < ws.columns; x++)
            for (let h = 1; y + h <= ws.rows; h++) for (let w = 1; x + w <= ws.columns; w++) {
                const candidate = { x, y, w, h };
                if ((!best || w * h > best.w * best.h) && !occupied.some(p => overlaps(p, candidate))) best = candidate;
            }
        if (!best) break;
        spaces.push(best); occupied.push(best);
    }
    while (spaces.length < moving.length) {
        spaces.sort((a, b) => b.w * b.h - a.w * a.h);
        const a = spaces.shift()!;
        if (a.w * a.h < 2) return;
        const horizontal = a.w > 1 && (a.w >= a.h || a.h === 1), half = Math.floor((horizontal ? a.w : a.h) / 2);
        spaces.push(horizontal ? { ...a, w: half } : { ...a, h: half }, horizontal ? { ...a, x: a.x + half, w: a.w - half } : { ...a, y: a.y + half, h: a.h - half });
    }
    spaces.sort((a, b) => b.w * b.h - a.w * a.h);
    const result = [fixed, ...keep.map(p => ({ ...p }))];
    for (const space of spaces.slice(0, moving.length)) {
        moving.sort((a, b) => Math.hypot(a.x + a.w / 2 - space.x - space.w / 2, a.y + a.h / 2 - space.y - space.h / 2) - Math.hypot(b.x + b.w / 2 - space.x - space.w / 2, b.y + b.h / 2 - space.y - space.h / 2));
        result.push({ ...moving.shift()!, ...space });
    }
    return validGrid({ ...ws, panels: result }) ? result : undefined;
}
export function rearrange(ws: Workspace, width: number, height: number, mode: 1 | 2 | 3 = 1): Panel[] {
    if (!ws.panels.length) return [];
    const panels = [...ws.panels.filter(p => p.kind === 'files'), ...ws.panels.filter(p => p.kind === 'terminal')];
    const files = panels.filter(p => p.kind === 'files').length;
    const cellWidth = width / ws.columns, cellHeight = height / ws.rows;
    const priority: Kind | undefined = files && files < panels.length && mode !== 1 ? mode === 2 ? 'terminal' : 'files' : undefined;
    const widthCap = (panel: Panel) => automaticWidthCap(ws, panel, width, priority);
    const cap = (panel: Panel) => priority && panel.kind !== priority ? 1 : widthCap(panel);
    const maxArea = (kind: Kind) => panels.filter(p => p.kind === kind).reduce((sum, p) => sum + Math.min(ws.columns, cap(p)) * ws.rows, 0);
    const fileMax = maxArea('files'), terminalMax = maxArea('terminal');
    const available = priority ? ws.columns * ws.rows : Math.min(ws.columns * ws.rows, fileMax + terminalMax);
    const fileArea = priority ? priority === 'files' ? available - (panels.length - files) : files
        : Math.min(fileMax, Math.max(available - terminalMax, available * files / (files + 1.5 * (panels.length - files))));
    type Layout = { expandedTypes: number; mixedCuts: number; rotatedGroups: number; priorityArea: number; cost: number; panels: Panel[] };
    const cache = new Map<string, Layout[]>();
    function better(a: Layout, b?: Layout) {
        if (!b) return true;
        if (a.priorityArea !== b.priorityArea) return a.priorityArea > b.priorityArea;
        if (a.mixedCuts !== b.mixedCuts) return a.mixedCuts < b.mixedCuts;
        if (!priority && a.rotatedGroups !== b.rotatedGroups) return a.rotatedGroups < b.rotatedGroups;
        return a.cost < b.cost - 1e-9;
    }
    // Compare bounded rectangular splits; cache equivalent subproblems on the eight-cell grid.
    function arrange(start: number, count: number, w: number, h: number): Layout[] {
        if (count > w * h) return [];
        const key = `${start},${count},${w},${h}`;
        if (cache.has(key)) return cache.get(key)!;
        // Keep alternatives that leave reading room for both types in Balanced mode.
        const choices = new Map<number, Layout>();
        if (count === 1) {
            const panel = panels[start], terminal = panel.kind === 'terminal';
            // Reserve space for the priority type before reclaiming unused neighboring cells.
            const secondary = priority && panel.kind !== priority;
            const usedW = Math.min(w, cap(panel)), usedH = secondary ? 1 : h;
            const area = terminal ? (available - fileArea) / (panels.length - files) : fileArea / files;
            const aspect = usedW * cellWidth / (usedH * cellHeight);
            // Favor readable terminal rows and balanced areas; file lists tolerate tall shapes.
            const cost = (terminal ? 1 : .35) * Math.log(aspect / (terminal ? 1.8 : .5)) ** 2
                + (terminal ? 3 * Math.max(0, Math.log(720 / (usedW * cellWidth))) ** 2 : 0)
                + (!terminal && !priority ? .8 * Math.log(ws.rows / usedH) ** 2 : 0)
                + 1.5 * Math.log(usedW * usedH / area) ** 2 + 8 * (w * h - usedW * usedH) / area;
            const expandedTypes = !priority && usedW * usedH > 1 ? terminal ? 2 : 1 : 0;
            choices.set(expandedTypes, { expandedTypes, mixedCuts: 0, rotatedGroups: 0, priorityArea: panel.kind === priority ? usedW * usedH : 0, cost,
                panels: [{ ...panel, x: Math.floor((w - usedW) / 2), y: Math.floor((h - usedH) / 2), w: usedW, h: usedH }] });
        } else for (const vertical of [true, false]) {
            for (let cut = 1; cut < (vertical ? w : h); cut++) for (let n = 1; n < count; n++) {
                for (const a of arrange(start, n, vertical ? cut : w, vertical ? h : cut))
                for (const b of arrange(start + n, count - n, vertical ? w - cut : w, vertical ? h : h - cut)) {
                    const mixed = start < files && start + count > files;
                    const candidate: Layout = {
                        expandedTypes: a.expandedTypes | b.expandedTypes,
                        mixedCuts: a.mixedCuts + b.mixedCuts + Number(mixed && start + n !== files),
                        rotatedGroups: a.rotatedGroups + b.rotatedGroups + Number(mixed && start + n === files && vertical !== (width >= height)),
                        priorityArea: a.priorityArea + b.priorityArea,
                        cost: a.cost + b.cost, panels: [],
                    };
                    if (!better(candidate, choices.get(candidate.expandedTypes))) continue;
                    choices.set(candidate.expandedTypes, { ...candidate, panels: [...a.panels, ...b.panels.map(p => ({
                        ...p, x: p.x + (vertical ? cut : 0), y: p.y + (vertical ? 0 : cut),
                    }))] });
                }
            }
        }
        const result = [...choices.values()];
        cache.set(key, result);
        return result;
    }
    let best: Layout | undefined, usedWidth = ws.columns;
    const minWidth = Math.min(ws.columns, Math.max(...panels.map(cap)));
    for (let w = ws.columns; w >= minWidth; w--) {
        for (const layout of arrange(0, panels.length, w, ws.rows)) {
            const unused = available - layout.panels.reduce((sum, p) => sum + p.w * p.h, 0);
            const candidate = { ...layout, cost: layout.cost + 1.5 * unused / (available / panels.length) };
            if (!priority && files && files < panels.length && best && (candidate.expandedTypes === 3) !== (best.expandedTypes === 3)) {
                if (candidate.expandedTypes === 3) { best = candidate; usedWidth = w; }
                continue;
            }
            if (better(candidate, best)) { best = candidate; usedWidth = w; }
        }
    }
    const result = best!.panels.map(p => ({ ...p, x: p.x + Math.floor((ws.columns - usedWidth) / 2) }));
    for (const panel of [...result].sort((a, b) => Number(b.kind === priority) - Number(a.kind === priority)))
        Object.assign(panel, expandedRect({ ...ws, panels: result }, panel, widthCap(panel)));
    return ws.panels.map(panel => result.find(p => p.id === panel.id)!);
}
export function cycleLayout(ws: Workspace, width: number, height: number) {
    if (!ws.panels.length) return;
    if (ws.layout?.mode === 3) {
        for (const panel of ws.panels) Object.assign(panel, ws.layout.custom.find(p => p.id === panel.id)!);
        delete ws.layout;
    } else {
        const custom = ws.layout?.custom || ws.panels.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
        const mode = ((ws.layout?.mode || 0) + 1) as 1 | 2 | 3;
        rearrange(ws, width, height, mode).forEach(next => Object.assign(ws.panels.find(p => p.id === next.id)!, next));
        ws.layout = { mode, custom };
    }
}
