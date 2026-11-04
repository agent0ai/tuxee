import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({ entryPoints: ['web/model.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/shared-layout.mjs' });
const { sharedDividers, resizeDividers, dropLayout, validGrid } = await import('../.test-state/shared-layout.mjs');
const panel = (id, x, y, w, h) => ({ id, kind: 'files', path: '/', x, y, w, h });
const workspace = panels => ({ columns: 4, rows: 2, panels });
const pair = workspace([panel('a', 0, 0, 2, 2), panel('b', 2, 0, 2, 2)]);
for (const ws of [
    pair,
    workspace([pair.panels[0], panel('b', 2, 0, 2, 1), panel('c', 2, 1, 2, 1)]),
    workspace([panel('a', 0, 0, 2, 1), panel('b', 2, 0, 2, 1), panel('c', 0, 1, 2, 1), panel('d', 2, 1, 2, 1)]),
]) {
    const before = structuredClone(ws);
    for (const transpose of [false, true]) {
        const source = transpose ? { columns: ws.rows, rows: ws.columns, panels: ws.panels.map(p => ({ ...p, x: p.y, y: p.x, w: p.h, h: p.w })) } : ws;
        const dividers = sharedDividers(source);
        for (const delta of [-20, -1, 0, 1, 20]) {
            const next = resizeDividers(source, dividers, transpose ? 0 : delta, transpose ? delta : 0);
            assert.ok(validGrid({ ...source, panels: next }));
            assert.equal(next.reduce((n, p) => n + p.w * p.h, 0), 8);
            assert.equal(next[0][transpose ? 'h' : 'w'], Math.max(1, Math.min(3, 2 + delta)));
        }
    }
    assert.deepEqual(ws, before);
}
const blocked = workspace([panel('a', 0, 0, 1, 2), panel('b', 1, 0, 1, 2)]);
assert.equal(sharedDividers(blocked)[0].min, sharedDividers(blocked)[0].max);
const obstacles = workspace([panel('a', 0, 0, 2, 2), panel('b', 2, 0, 2, 1), panel('c', 3, 1, 1, 1)]);
assert.equal(sharedDividers(obstacles)[0].max, 3);
const split = { columns: 2, rows: 4, panels: [panel('a', 0, 0, 1, 1), panel('b', 1, 0, 1, 1), panel('c', 0, 3, 1, 1), panel('d', 1, 3, 1, 1)] };
assert.equal(sharedDividers(split).length, 2, 'separated gaps stay independent');
const square = { columns: 2, rows: 4, panels: [panel('a', 0, 0, 1, 2), panel('b', 1, 0, 1, 2), panel('c', 0, 2, 1, 2), panel('d', 1, 2, 1, 2)] };
assert.ok(validGrid({ ...square, panels: resizeDividers(square, sharedDividers(square), 1, -1) }));
const moving = panel('moving', 0, 0, 1, 1);
for (const rect of [{ x: 1, y: 0, w: 2, h: 1 }, { x: 1, y: 0, w: 2, h: 2 }]) {
    const ws = workspace([moving, panel('neighbor', 2, 0, 2, 2)]);
    const before = structuredClone(ws), next = dropLayout(ws, moving, rect);
    assert.ok(validGrid({ ...ws, panels: next }));
    assert.deepEqual(ws, before);
    assert.equal(next.length, 2);
    assert.equal(next.find(p => p.id === 'neighbor').w * next.find(p => p.id === 'neighbor').h, 2);
}
assert.ok(validGrid({ ...blocked, panels: dropLayout(blocked, moving, { x: 0, y: 0, w: 2, h: 2 }) }));
const geometry = p => [p.x, p.y, p.w, p.h];
const sketch = ws => Array.from({ length: ws.rows }, (_, y) => Array.from({ length: ws.columns }, (_, x) =>
    ws.panels.find(p => !p.minimized && x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)?.id || ' ').join('')).join('\n');
for (const transpose of [false, true]) {
    const turn = p => transpose ? { ...p, x: p.y, y: p.x, w: p.h, h: p.w } : p;
    const source = { columns: transpose ? 2 : 4, rows: transpose ? 4 : 2,
        panels: [panel('A', 0, 0, 1, 2), panel('B', 1, 0, 1, 1), panel('C', 2, 0, 2, 2)].map(turn) };
    for (const [target, expected, minimized] of [
        [[0, 0, 2, 2], 'DDCC\nDDCC', ['A', 'B']],
        [[0, 1, 2, 1], 'ABCC\nDDCC', []],
        [[0, 0, 2, 1], 'DDCC\nABCC', []],
    ]) {
        const [x, y, w, h] = target, result = dropLayout(source, turn(panel('D', 0, 0, 1, 1)), turn({ x, y, w, h }), true);
        assert.ok(validGrid({ ...source, panels: result }));
        assert.equal(sketch({ columns: 4, rows: 2, panels: result.map(turn) }), expected);
        assert.deepEqual(result.filter(p => p.minimized).map(p => p.id).sort(), minimized);
        assert.deepEqual(result.find(p => p.id === 'C'), source.panels[2], 'uncovered C keeps its complete rectangle');
    }
    const sourceGroup = { ...source, panels: [panel('A', 0, 0, 1, 1), panel('B', 1, 0, 1, 1), panel('C', 0, 1, 2, 1), panel('D', 2, 0, 2, 2)].map(turn) };
    const swapped = dropLayout(sourceGroup, sourceGroup.panels[3], turn({ x: 0, y: 0, w: 2, h: 2 }), true);
    assert.equal(sketch({ columns: 4, rows: 2, panels: swapped.map(turn) }), 'DDAB\nDDCC', 'covered group swaps into the source with sizes and relative positions intact');
    const half = { ...source, panels: [panel('A', 0, 0, 2, 2), panel('D', 2, 0, 2, 2)].map(turn) };
    const swappedHalf = dropLayout(half, half.panels[1], turn({ x: 0, y: 0, w: 2, h: 2 }), true);
    assert.equal(sketch({ columns: 4, rows: 2, panels: swappedHalf.map(turn) }), 'DDAA\nDDAA', 'whole windows swap halves');
}
for (const [target, expected] of [
    [[0, 1, 2, 1], [0, 0, 1, 1]], [[1, 0, 1, 2], [0, 1, 1, 1]],
]) {
    const a = panel('a', 0, 0, 1, 2), b = panel('b', 1, 1, 1, 1);
    const ws = { columns: 2, rows: 4, panels: [a, b, panel('fixed', 0, 2, 2, 2)] }, [x, y, w, h] = target;
    const result = dropLayout(ws, a, { x, y, w, h });
    assert.ok(validGrid({ ...ws, panels: result }));
    assert.deepEqual(geometry(result.find(p => p.id === 'b')), expected, 'move covered B into the vacated source');
    assert.deepEqual(geometry(result.find(p => p.id === 'a')), target);
}
const squeezed = workspace([panel('a', 0, 0, 1, 1), panel('b', 2, 0, 2, 2), panel('c', 0, 1, 1, 1), panel('d', 1, 0, 1, 2)]);
const squeezedResult = dropLayout(squeezed, squeezed.panels[0], { x: 2, y: 0, w: 2, h: 2 });
assert.deepEqual(geometry(squeezedResult.find(p => p.id === 'b')), [0, 0, 1, 1], 'move and shrink into the dragged panel’s old cell');
assert.deepEqual(squeezedResult.filter(p => ['c', 'd'].includes(p.id)), squeezed.panels.slice(2));
const shared = workspace([panel('a', 0, 0, 2, 1), panel('b', 2, 0, 1, 1), panel('c', 3, 0, 1, 2), panel('fixed', 1, 1, 1, 1)]);
const sharedResult = dropLayout(shared, shared.panels[0], { x: 2, y: 0, w: 2, h: 2 });
assert.deepEqual(geometry(sharedResult.find(p => p.id === 'b')), [0, 0, 1, 1]);
assert.deepEqual(geometry(sharedResult.find(p => p.id === 'c')), [1, 0, 1, 1], 'fit the covered group into the vacated source before using other gaps');
const full = workspace(Array.from({ length: 8 }, (_, i) => panel(String(i), i % 4, Math.floor(i / 4), 1, 1)));
assert.equal(dropLayout(full, full.panels[0], { x: 0, y: 0, w: 2, h: 1 }), undefined, 'reject a full grid without deleting a panel');
assert.equal(dropLayout(full, moving, { x: 0, y: 0, w: 1, h: 1 }), undefined, 'new panels do not vacate a cell');
assert.equal(dropLayout(full, full.panels[0], { x: -1, y: 0, w: 2, h: 1 }), undefined);
for (const source of [moving, full.panels[0]]) {
    const before = structuredClone(full), rect = { x: 2, y: 0, w: 2, h: 2 };
    const result = dropLayout(full, source, rect, true);
    assert.ok(validGrid({ ...full, panels: result }));
    assert.deepEqual(geometry(result.find(p => p.id === source.id)), [2, 0, 2, 2]);
    assert.equal(result.filter(p => p.minimized).length, source === moving ? 4 : 3);
    assert.deepEqual(result.filter(p => ['1', '4', '5'].includes(p.id)), full.panels.filter(p => ['1', '4', '5'].includes(p.id)));
    assert.deepEqual(full, before);
}

const crowded = workspace([panel('fixed', 0, 0, 2, 2), panel('a', 2, 0, 1, 1), panel('b', 3, 0, 1, 1), panel('c', 2, 1, 1, 1)]);
const rescued = dropLayout(crowded, moving, { x: 2, y: 0, w: 2, h: 2 }, true);
assert.ok(validGrid({ ...crowded, panels: rescued }));
assert.equal(rescued.filter(p => p.minimized).length, 3, 'minimize covered windows instead of shrinking an untouched window');
assert.deepEqual(rescued.find(p => p.id === 'fixed'), crowded.panels[0]);
console.log('PASS shared dividers and drops: replacement examples, group swaps, source-space resizing, fixed neighbors and full-grid rejection');

let seed = 12345, checked = 0, slowest = 0;
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
for (const [columns, rows] of [[4, 2], [2, 4]]) for (let sample = 0; sample < 60; sample++) {
    const panels = [panel('0', 0, 0, columns, rows)];
    for (let split = 0; split < 10; split++) {
        const p = panels[random(panels.length)], horizontal = p.w > 1 && (p.h === 1 || random(2));
        const size = horizontal ? 'w' : 'h', axis = horizontal ? 'x' : 'y';
        if (p[size] < 2) continue;
        const cut = 1 + random(p[size] - 1);
        panels.push({ ...p, id: String(panels.length), [axis]: p[axis] + cut, [size]: p[size] - cut }); p[size] = cut;
    }
    if (panels.length > 1 && random(2)) panels.splice(random(panels.length), 1);
    const ws = { columns, rows, panels }, before = structuredClone(ws);
    const source = random(3) ? panels[random(panels.length)] : moving;
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++)
        for (let h = 1; y + h <= rows; h++) for (let w = 1; x + w <= columns; w++) {
            const target = { x, y, w, h }, others = panels.filter(p => p.id !== source.id), fixed = others.filter(p => !intersects(p, target));
            const possible = columns * rows - w * h - fixed.reduce((sum, p) => sum + p.w * p.h, 0) >= others.length - fixed.length;
            const start = performance.now(), result = dropLayout(ws, source, target);
            slowest = Math.max(slowest, performance.now() - start); checked++;
            assert.equal(!!result, possible, JSON.stringify({ ws, source, target }));
            const overflow = dropLayout(ws, source, target, true);
            assert.ok(overflow && validGrid({ ...ws, panels: overflow }), 'every in-bounds drag/resize fits');
            for (const p of overflow.filter(p => p.minimized)) assert.ok(p.x >= x && p.y >= y && p.x + p.w <= x + w && p.y + p.h <= y + h, 'only fully covered windows may be minimized');
            const available = columns * rows - w * h - fixed.reduce((sum, p) => sum + p.w * p.h, 0);
            assert.equal(overflow.filter(p => p.minimized).length, Math.max(0, others.length - fixed.length - available), 'minimize only the overlaps that cannot fit without disturbing fixed windows');
            for (const p of fixed) assert.deepEqual(overflow.find(next => next.id === p.id), p, 'unaffected panels never move even when minimizing');
            if (!result) continue;
            assert.ok(validGrid({ ...ws, panels: result }));
            assert.equal(result.length, others.length + 1);
            assert.deepEqual(geometry(result.find(p => p.id === source.id)), [x, y, w, h]);
            for (const p of fixed) assert.deepEqual(result.find(next => next.id === p.id), p, 'unaffected panels never move');
            for (const p of others) {
                const next = result.find(next => next.id === p.id);
                assert.ok(next.w <= p.w && next.h <= p.h, 'neighbors never grow or rotate');
            }
            if (checked % 41 === 0) assert.deepEqual(dropLayout(ws, source, target), result, 'preview planning is deterministic');
        }
    assert.deepEqual(ws, before, 'preview planning never changes saved layout');
}
console.log(`PASS ${checked} generated drop/resize cases across both eight-cell grids; slowest planning call ${slowest.toFixed(1)}ms`);
