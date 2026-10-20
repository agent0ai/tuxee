import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('.test-state', { recursive: true });
await build({ entryPoints: ['web/model.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/model.mjs' });
const { newWorkspace, newPanel, split, validGrid, addCompact, place, gridDrop, screenSnap, snapLayout, rearrange, cycleLayout, expandPanel, expandAfterClose } = await import('../.test-state/model.mjs');
for (const [width, height, columns, rows, count] of [[1440, 1000, 4, 2, 3], [2560, 1080, 8, 2, 4], [900, 1200, 2, 4, 2], [390, 844, 4, 2, 2]]) {
    const ws = newWorkspace('test', '/home/test', width, height);
    assert.equal(ws.columns, columns);
    assert.equal(ws.rows, rows);
    assert.equal(ws.panels.length, count);
    assert.deepEqual(ws.panels.filter(panel => panel.kind === 'files').map(panel => panel.path), count >= 3 ? ['/', '/home/test'] : ['/']);
    if (count === 3) assert.deepEqual(ws.panels.map(({ kind, x, y, w, h }) => [kind, x, y, w, h]), [
        ['files', 0, 0, 2, 1], ['files', 0, 1, 2, 1], ['terminal', 2, 0, 2, 2],
    ]);
    assert.ok(ws.panels.filter(panel => panel.kind === 'terminal').every(panel => panel.path === '/home/test'));
    assert.ok(validGrid(ws));
    while (addCompact(ws, newPanel('terminal', '/home/test')))
        assert.ok(validGrid(ws));
    assert.equal(ws.panels.length, columns * rows);
    assert.equal(addCompact(ws, newPanel('files', '/')), false);
}
assert.deepEqual(newWorkspace('root', '/root', 2560, 1080).panels.filter(panel => panel.kind === 'files').map(panel => panel.path), ['/', '/root']);
for (const edge of ['left', 'right', 'top', 'bottom']) {
    const ws = newWorkspace('test', '/', 390, 844), panel = newPanel('terminal', '/');
    assert.ok(split(ws, ws.panels[0].id, panel, edge));
    assert.ok(validGrid(ws));
    assert.equal(ws.panels.length, 3);
    const moving = ws.panels[1];
    assert.ok(split(ws, panel.id, moving, edge === 'left' || edge === 'right' ? 'top' : 'left'));
    assert.ok(validGrid(ws));
    assert.equal(ws.panels.length, 3);
}
const empty = newWorkspace('move', '/', 390, 844);
const moving = empty.panels[0];
assert.equal(place(empty, moving, { x: 2, y: 0, w: 2, h: 2 }), false);
empty.panels.pop();
assert.equal(place(empty, moving, { x: 2, y: 0, w: 2, h: 2 }), true);
assert.equal(empty.panels.length, 1);
assert.equal(place(empty, moving, { x: 3, y: 0, w: 2, h: 2 }), false);
assert.equal(moving.x, 2);
assert.ok(validGrid(empty));
console.log('PASS grid defaults, split bounds, empty-area placement and capacity');
for (const [width, height] of [[1440, 1000], [2560, 1080], [3440, 1440], [900, 1200]]) {
    const ws = newWorkspace('grid drop', '/', width, height), cw = width / ws.columns, ch = height / ws.rows;
    for (let y = 0; y < ws.rows; y++) for (let x = 0; x < ws.columns; x++) {
        assert.deepEqual(gridDrop(ws, (x + .5) * cw, (y + .5) * ch, width, height), { x, y, w: 1, h: 1 });
        if (x + 1 < ws.columns) assert.deepEqual(gridDrop(ws, (x + 1) * cw, (y + .5) * ch, width, height), { x, y, w: 2, h: 1 });
        if (y + 1 < ws.rows) assert.deepEqual(gridDrop(ws, (x + .5) * cw, (y + 1) * ch, width, height), { x, y, w: 1, h: 2 });
        if (x + 1 < ws.columns && y + 1 < ws.rows) assert.deepEqual(gridDrop(ws, (x + 1) * cw, (y + 1) * ch, width, height), { x, y, w: 2, h: 2 });
    }
    for (const dx of [-31, 31]) assert.deepEqual(gridDrop(ws, cw + dx, ch / 2, width, height), { x: 0, y: 0, w: 2, h: 1 });
    assert.deepEqual(gridDrop(ws, cw + 33, ch / 2, width, height), { x: 1, y: 0, w: 1, h: 1 });
    for (const [x, y] of [[-1, 50], [width, 50], [50, -1], [50, height]]) assert.equal(gridDrop(ws, x, y, width, height), undefined);
    assert.deepEqual(gridDrop(ws, width - 1, height - 1, width, height), { x: ws.columns - 1, y: ws.rows - 1, w: 1, h: 1 });
}
const hole = newWorkspace('small hole', '/', 390, 844), large = hole.panels[0];
hole.panels = [large, { ...hole.panels[1], x: 2, w: 1 }, { ...newPanel('files', '/'), x: 3, y: 0 }];
const unchanged = structuredClone(hole);
assert.equal(place(hole, large, { x: 2, y: 1, w: 2, h: 1 }), false);
assert.deepEqual(hole, unchanged, 'blocked placements must not resize or move any panel');
assert.ok(place(hole, large, gridDrop(hole, 1260, 750, 1440, 1000)));
assert.deepEqual([large.x, large.y, large.w, large.h], [3, 1, 1, 1]);
assert.deepEqual(hole.panels.slice(1), unchanged.panels.slice(1));
assert.ok(validGrid(hole));
const added = newPanel('terminal', '/');
assert.ok(place(hole, added, { x: 0, y: 0, w: 2, h: 2 }));
assert.ok(validGrid(hole));
console.log('PASS pointer grid targets: single cells, adjacent pairs, crossings, bounds and resizing into a smaller hole without moving neighbors');
await build({ entryPoints: ['web/file-drag.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/file-drag.mjs' });
const { shellPaths, fileGroupLabel } = await import('../.test-state/file-drag.mjs');
const files = [{path:"/tmp/it's a file.txt",name:"it's a file.txt",directory:false}];
assert.equal(shellPaths(files), "'/tmp/it'\\''s a file.txt' ");
assert.equal(fileGroupLabel([...files, {path:'/tmp/a',name:'a',directory:true}]), '1 folder, 1 file');
console.log('PASS file drag group labels and shell quoting');

await build({ entryPoints: ['web/overflow.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/overflow.mjs' });
const { fittingHeaderItemCount } = await import('../.test-state/overflow.mjs');
assert.equal(fittingHeaderItemCount([100,100,100], 308, 30, 4), 3);
assert.equal(fittingHeaderItemCount([100,100,100], 250, 30, 4), 2);
assert.equal(fittingHeaderItemCount([100,100], 120, 30, 4), 0);
assert.equal(fittingHeaderItemCount([], 200, 30, 4), 0);
console.log('PASS UUI header fitting and overflow-button reservation');

for (const [width,height] of [[1440,1000],[2560,1080],[900,1200]]) {
    const ws = newWorkspace('snap','/',width,height);
    while (ws.panels.length < Math.min(5,ws.columns*ws.rows)) addCompact(ws,newPanel('terminal','/'));
    const target = screenSnap(ws,width*.8,2,width,height);
    assert.ok(target);
    const next = snapLayout(ws,ws.panels.at(-1),target);
    assert.ok(next && validGrid({...ws,panels:next}));
    assert.equal(next.length,ws.panels.length);
    const arranged = rearrange(ws,width,height);
    assert.ok(validGrid({...ws,panels:arranged}));
    assert.equal(arranged.length,ws.panels.length);
}
const single = newWorkspace('center','/',2560,1080); single.panels = [single.panels[0]];
const centered = rearrange(single,2560,1080)[0]; assert.equal(centered.w,2); assert.equal(centered.x,3);
assert.equal(screenSnap(single,1000,100,2560,1080), undefined);
console.log('PASS screen-edge snapping, neighboring-panel reflow and centered rearrangement');

for (const [width,height] of [[1440,1000],[2560,1080],[900,1200]]) {
    const ws = newWorkspace('expand','/',width,height), panel = ws.panels[0];
    const neighbors = JSON.stringify(ws.panels.slice(1));
    Object.assign(panel, expandPanel(ws, panel));
    assert.equal(panel.w * panel.h, 1, 'a blocked panel shrinks');
    Object.assign(panel, expandPanel(ws, panel));
    assert.equal(panel.w * panel.h, ws.panels.length === 3 ? 2 : 4);
    assert.equal(JSON.stringify(ws.panels.slice(1)), neighbors);
    assert.ok(validGrid(ws));
    ws.panels = [panel]; Object.assign(panel, {x:1,y:1,w:1,h:1});
    assert.deepEqual(expandPanel(ws,panel),{x:0,y:0,w:ws.columns,h:ws.rows});
}
console.log('PASS double-click expands into free space in all directions or shrinks, without moving neighbors');

const closeCases = [
    ['left only', 8, 2, [1, 0, 1, 1], [['terminal', 2, 0, 1, 1]], [[1, 0, 2, 1]]],
    ['right only', 8, 2, [2, 0, 1, 1], [['terminal', 1, 0, 1, 1]], [[1, 0, 2, 1]]],
    ['up only', 2, 4, [0, 1, 1, 1], [['terminal', 0, 2, 1, 1]], [[0, 1, 1, 2]]],
    ['down only', 2, 4, [0, 2, 1, 1], [['terminal', 0, 1, 1, 1]], [[0, 1, 1, 2]]],
    ['smallest first despite input order', 8, 2, [1, 0, 2, 2], [['terminal', 3, 0, 2, 2], ['terminal', 0, 0, 1, 1]], [[3, 0, 2, 2], [0, 0, 3, 1]]],
    ['stacked neighbors share the hole', 8, 2, [1, 0, 2, 2], [['terminal', 0, 0, 1, 1], ['terminal', 0, 1, 1, 1]], [[0, 0, 3, 1], [0, 1, 3, 1]]],
    ['skip a capped smaller neighbor', 8, 2, [2, 0, 2, 2], [['files', 0, 0, 2, 1], ['terminal', 4, 0, 2, 2]], [[0, 0, 2, 1], [2, 0, 4, 2]]],
    ['skip a blocked smaller neighbor', 8, 2, [1, 0, 2, 1], [['terminal', 0, 0, 1, 2], ['terminal', 1, 1, 3, 1]], [[0, 0, 1, 2], [1, 0, 3, 2]]],
    ['file two-cell cap', 8, 2, [1, 0, 3, 2], [['files', 0, 0, 1, 2]], [[0, 0, 2, 2]]],
    ['file growth ignores arranger pixel preference', 8, 2, [1, 0, 2, 2], [['files', 0, 0, 1, 2]], [[0, 0, 2, 2]]],
    ['terminal growth ignores arranger pixel preference', 8, 2, [1, 0, 5, 2], [['terminal', 0, 0, 1, 2]], [[0, 0, 6, 2]]],
    ['oversized manual widths may grow vertically', 8, 2, [0, 1, 5, 1], [['files', 0, 0, 5, 1]], [[0, 0, 5, 2]]],
    ['corners and separated windows stay put', 8, 2, [1, 0, 1, 1], [['terminal', 2, 1, 1, 1], ['terminal', 4, 0, 1, 2]], [[2, 1, 1, 1], [4, 0, 1, 2]]],
    ['standard desktop closes into its other file browser', 4, 2, [0, 1, 2, 1], [['files', 0, 0, 2, 1], ['terminal', 2, 0, 2, 2]], [[0, 0, 2, 2], [2, 0, 2, 2]]],
    ['last panel', 4, 2, [0, 0, 4, 2], [], []],
];
for (const [name, columns, rows, removed, shapes, expected] of closeCases) {
    const [x, y, w, h] = removed, closed = { x, y, w, h };
    const panels = shapes.map(([kind, x, y, w, h], i) => ({ ...newPanel(kind, '/'), id: String(i), x, y, w, h }));
    const ws = { id: 'close', name, columns, rows, panels, active: panels[0]?.id || '' };
    assert.ok(validGrid({ ...ws, panels: [...panels, { ...newPanel('files', '/'), ...closed }] }), name);
    expandAfterClose(ws, closed);
    assert.ok(validGrid(ws), name);
    assert.deepEqual(ws.panels.map(({ x, y, w, h }) => [x, y, w, h]), expected, name);
    assert.ok(ws.panels.every((panel, i) => panel === panels[i]), 'keep original panel identities');
}
console.log('PASS close expansion: four directions, smallest-first, shared holes, caps, portrait, unrelated gaps and stable identities');
let closeChecks = 0;
for (const [columns, rows] of [[4, 2], [8, 2], [2, 4]]) {
    const layouts = [];
    for (let x = 1; x < columns; x++) {
        layouts.push([[0, 0, x, rows], [x, 0, columns - x, rows]]);
        for (let y = 1; y < rows; y++) {
            const tl = [0, 0, x, y], bl = [0, y, x, rows - y];
            const tr = [x, 0, columns - x, y], br = [x, y, columns - x, rows - y];
            layouts.push([tl, bl, [x, 0, columns - x, rows]], [[0, 0, x, rows], tr, br],
                [tl, tr, [0, y, columns, rows - y]], [[0, 0, columns, y], bl, br], [tl, bl, tr, br]);
        }
    }
    for (let y = 1; y < rows; y++) layouts.push([[0, 0, columns, y], [0, y, columns, rows - y]]);
    for (const shapes of layouts) for (let removed = 0; removed < shapes.length; removed++) {
        const original = shapes.map(([x, y, w, h], i) => ({ ...newPanel('terminal', '/'), id: String(i), x, y, w, h }));
        const closed = original[removed], panels = original.filter(p => p !== closed).map(p => ({ ...p }));
        const ws = { id: 'sweep', name: 'Terminals', columns, rows, panels, active: panels[0].id };
        expandAfterClose(ws, closed);
        const label = `${columns}x${rows} close ${removed} in ${JSON.stringify(shapes)}`;
        assert.ok(validGrid(ws), label);
        assert.equal(panels.reduce((sum, p) => sum + p.w * p.h, 0), columns * rows, label);
        for (const p of panels) {
            const before = original.find(old => old.id === p.id);
            const edges = rect => [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h];
            assert.ok(edges(p).filter((edge, i) => edge !== edges(before)[i]).length <= 1, label);
            assert.ok(p.x <= before.x && p.y <= before.y && p.x + p.w >= before.x + before.w && p.y + p.h >= before.y + before.h, label);
        }
        closeChecks++;
    }
}
console.log(`PASS ${closeChecks} terminal closures: every side of pairs, T layouts and four-panel grids, including unequal splits and portrait`);
{
    const ws = newWorkspace('closing', '/', 1440, 1000), [first, second, terminal] = ws.panels;
    ws.panels = ws.panels.filter(p => p !== first);
    expandAfterClose(ws, first, [terminal]);
    assert.deepEqual([second.x, second.y, second.w, second.h], [0, 1, 2, 1], 'another closing window cannot grow');
    assert.equal(terminal.x, 2, 'another closing window still blocks expansion');
    ws.panels = [terminal];
    expandAfterClose(ws, second);
    assert.deepEqual([terminal.x, terminal.y, terminal.w, terminal.h], [0, 0, 4, 2]);
}

function fixture(width, height, files, terminals) {
    const ws = newWorkspace('arrange', '/', width, height);
    ws.panels = [];
    // Interleave the input to prove that grouping comes from the arranger.
    for (let i = 0; i < Math.max(files, terminals); i++) for (const [kind, count] of [['files', files], ['terminal', terminals]]) {
        if (i < count) {
            const index = ws.panels.length;
            ws.panels.push({ ...newPanel(kind, '/'), id: `${kind === 'files' ? 'F' : 'T'}${i + 1}`, x: index % ws.columns, y: Math.floor(index / ws.columns) });
        }
    }
    return ws;
}
function diagram(ws) {
    return Array.from({ length: ws.rows }, (_, y) => Array.from({ length: ws.columns }, (_, x) =>
        (ws.panels.find(p => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)?.id || '.').padStart(3),
    ).join(' ')).join('\n');
}
for (const [width, height] of [[1280, 800], [1440, 1000]]) {
    const ws = fixture(width, height, 1, 1);
    const shapes = mode => rearrange(ws, width, height, mode).map(({ w, h }) => [w, h]);
    assert.deepEqual(shapes(1), [[1, 2], [3, 2]]);
    assert.deepEqual(shapes(2), [[1, 2], [3, 2]], 'terminal priority must reuse the empty cell below the file browser');
    assert.deepEqual(shapes(3), [[2, 2], [2, 2]], 'file priority must let the terminal fill its unused half');
}
console.log('PASS priority layouts reclaim neighboring free cells instead of leaving secondary panels minimized');
const report = [], start = performance.now();
let cases = 0, slowest = 0;
for (const [width, height] of [[1280, 800], [1440, 1000], [1920, 1080], [2560, 1080], [3440, 1440], [5120, 1440], [900, 1200], [1080, 1920]]) {
    const { columns, rows } = newWorkspace('capacity', '/', width, height), capacity = columns * rows;
    for (let files = 0; files <= capacity; files++) for (let terminals = 0; terminals <= capacity - files; terminals++) {
        const ws = fixture(width, height, files, terminals), original = structuredClone(ws);
        const areas = [];
        for (const mode of [1, 2, 3]) {
            const before = performance.now(), panels = rearrange(ws, width, height, mode);
            slowest = Math.max(slowest, performance.now() - before);
            assert.deepEqual(ws, original, 'rearrange must not mutate its input');
            assert.ok(validGrid({ ...ws, panels }));
            assert.deepEqual(panels.map(p => p.id), ws.panels.map(p => p.id), 'preserve identity and tab order');
            assert.deepEqual(rearrange({ ...ws, panels }, width, height, mode), panels, 'repeated modes must be stable');
            for (const p of panels) {
                assert.ok([p.x, p.y, p.w, p.h].every(Number.isInteger));
                if (p.kind === 'files') assert.ok(p.w <= 2, `${width}x${height} mode ${mode}: file browsers stay within two columns`);
                const priority = files && terminals && mode !== 1 ? mode === 2 ? 'terminal' : 'files' : undefined;
                const maxWidth = Math.min(p.kind === 'files' ? 2 : columns,
                    p.kind === priority ? columns : Math.max(1, Math.floor((p.kind === 'files' ? 640 : 1440) / (width / columns))));
                assert.ok(p.w <= maxWidth);
                for (const rect of [
                    { x: p.x - 1, y: p.y, w: p.w + 1, h: p.h }, { x: p.x, y: p.y, w: p.w + 1, h: p.h },
                    { x: p.x, y: p.y - 1, w: p.w, h: p.h + 1 }, { x: p.x, y: p.y, w: p.w, h: p.h + 1 },
                ]) if (rect.w <= maxWidth) {
                    assert.ok(!validGrid({ ...ws, panels: panels.map(other => other === p ? { ...p, ...rect } : other) }),
                        `${width}x${height} mode ${mode}: ${p.id} must use adjacent free space within its width cap`);
                }
                const { x, y, w, h, ...metadata } = p, { x: ox, y: oy, w: ow, h: oh, ...expected } = ws.panels.find(old => old.id === p.id);
                assert.deepEqual(metadata, expected);
            }
            if (files && terminals) {
                const vertical = width >= height, span = vertical ? rows : columns, limit = vertical ? columns : rows;
                const extra = files + terminals <= capacity - 2 ? 1 : 0;
                const groupSpan = (count, cap) => Math.max(Math.ceil((count + extra) / span), !vertical && extra && cap < 2 * width / columns ? 2 : 1);
                if (mode === 1 && groupSpan(files, 640) + groupSpan(terminals, 1440) <= limit) {
                    for (const file of panels.filter(p => p.kind === 'files')) for (const terminal of panels.filter(p => p.kind === 'terminal')) {
                        const shareAxis = vertical ? file.y < terminal.y + terminal.h && terminal.y < file.y + file.h
                            : file.x < terminal.x + terminal.w && terminal.x < file.x + file.w;
                        if (shareAxis) assert.ok(vertical ? file.x + file.w <= terminal.x : file.y + file.h <= terminal.y,
                            `${width}x${height} ${files}F/${terminals}T: preserve type ordering while allowing stepped boundaries\n${diagram({ ...ws, panels })}`);
                    }
                }
            }
            report.push(`${width}x${height} · ${files} files / ${terminals} terminals · mode ${mode}\n${diagram({ ...ws, panels })}`);
            areas.push(['files', 'terminal'].map(kind => panels.filter(p => p.kind === kind).reduce((sum, p) => sum + p.w * p.h, 0)));
            cases++;
        }
        assert.ok(areas[1][1] >= areas[0][1], 'terminal priority must not reduce terminal space');
        assert.ok(areas[2][0] >= areas[0][0], 'file priority must not reduce file space');
        if (files && terminals && files + terminals <= capacity - 2) {
            assert.ok(areas[0][0] > files && areas[0][1] > terminals, 'Balanced leaves reading room for both types');
        }
    }
}
await writeFile('.test-state/layout-report.txt', report.join('\n\n') + '\n');
console.log(`PASS ${cases} layouts across 8 screen sizes/all panel mixes/3 modes (${Math.round(performance.now() - start)}ms; slowest ${slowest.toFixed(1)}ms). Diagrams: .test-state/layout-report.txt`);

for (const [width, height] of [[1280,800], [1440,1000], [1920,1080], [2560,1080], [3440,1440], [5120,1440], [900,1200], [1080,1920]]) {
    const ws = newWorkspace('default', '/home/test', width, height), custom = structuredClone(ws.panels);
    for (const mode of [1,2,3]) {
        cycleLayout(ws, width, height);
        assert.equal(ws.layout.mode, mode);
        assert.ok(validGrid(ws));
    }
    cycleLayout(ws, width, height);
    assert.deepEqual(ws.panels, custom);
}
console.log('PASS regular, portrait and ultrawide defaults cycle modes and restore');

const example = fixture(2560, 1080, 4, 4), balanced = rearrange(example, 2560, 1080);
assert.ok(balanced.filter(p => p.kind === 'files').every(p => p.w === 1 && p.h === 2));
assert.ok(balanced.filter(p => p.kind === 'terminal').every(p => p.w === 2 && p.h === 1));
for (const [width, height, f, t] of [[1280,800,1,1], [1440,1000,2,2], [1440,1000,2,3], [2560,1080,4,4], [3440,1440,2,2], [3440,1440,3,3], [3440,1440,1,5], [3440,1440,5,1], [900,1200,2,3], [1080,1920,4,2]]) {
    const ws = fixture(width, height, f, t), custom = structuredClone(ws.panels), layouts = [];
    for (let mode = 1; mode <= 3; mode++) {
        cycleLayout(ws, width, height);
        assert.equal(ws.layout.mode, mode);
        assert.ok(validGrid(ws));
        layouts.push(structuredClone(ws.panels));
        // Simulate saving/reloading between clicks.
        ws.layout = JSON.parse(JSON.stringify(ws.layout));
        console.log(`${width}x${height} ${f}F/${t}T mode ${mode}\n${diagram(ws)}`);
    }
    const area = (panels, kind) => panels.filter(p => p.kind === kind).reduce((sum, p) => sum + p.w * p.h, 0);
    assert.ok(area(layouts[1], 'terminal') >= area(layouts[0], 'terminal'));
    assert.ok(area(layouts[2], 'files') >= area(layouts[0], 'files'));
    if (f === 4 && t === 4) {
        assert.ok(area(layouts[1], 'terminal') > area(layouts[0], 'terminal'));
        assert.ok(area(layouts[2], 'files') > area(layouts[0], 'files'));
    }
    const terminal = ws.panels.find(p => p.kind === 'terminal');
    terminal.path = '/new/path'; terminal.terminal = 'live-session';
    const files = ws.panels.find(p => p.kind === 'files');
    files.name = 'Renamed during auto layout';
    cycleLayout(ws, width, height);
    assert.equal(ws.layout, undefined);
    const geometry = panels => panels.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
    assert.deepEqual(geometry(ws.panels), geometry(custom), 'fourth click restores exact custom geometry');
    assert.equal(terminal.path, '/new/path');
    assert.equal(terminal.terminal, 'live-session', 'restoring geometry must preserve current content/session');
    assert.equal(files.name, 'Renamed during auto layout', 'restoring geometry must preserve live browser labels');
}
console.log('PASS wider ultrawide terminals, area priorities and custom-layout restoration without reverting paths/sessions');
