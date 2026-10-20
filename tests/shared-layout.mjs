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
const split = { columns: 4, rows: 4, panels: [panel('a', 0, 0, 2, 1), panel('b', 2, 0, 2, 1), panel('c', 0, 3, 2, 1), panel('d', 2, 3, 2, 1)] };
assert.equal(sharedDividers(split).length, 2, 'separated gaps stay independent');
const square = { columns: 4, rows: 4, panels: [panel('a', 0, 0, 2, 2), panel('b', 2, 0, 2, 2), panel('c', 0, 2, 2, 2), panel('d', 2, 2, 2, 2)] };
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
for (const [target, expected] of [
    [[0, 1, 2, 1], [1, 0, 1, 1]], [[1, 0, 1, 2], [0, 1, 1, 1]],
]) {
    const a = panel('a', 0, 0, 1, 2), b = panel('b', 1, 1, 1, 1);
    const ws = { columns: 2, rows: 2, panels: [a, b] }, [x, y, w, h] = target;
    const result = dropLayout(ws, a, { x, y, w, h });
    assert.ok(validGrid({ ...ws, panels: result }));
    assert.deepEqual(geometry(result.find(p => p.id === 'b')), expected, 'move B to the nearest free cell');
    assert.deepEqual(geometry(result.find(p => p.id === 'a')), target);
}
const squeezed = workspace([panel('a', 0, 0, 1, 1), panel('b', 2, 0, 2, 2), panel('c', 0, 1, 1, 1), panel('d', 1, 0, 1, 2)]);
const squeezedResult = dropLayout(squeezed, squeezed.panels[0], { x: 2, y: 0, w: 2, h: 2 });
assert.deepEqual(geometry(squeezedResult.find(p => p.id === 'b')), [0, 0, 1, 1], 'move and shrink into the dragged panel’s old cell');
assert.deepEqual(squeezedResult.filter(p => ['c', 'd'].includes(p.id)), squeezed.panels.slice(2));
const shared = workspace([panel('a', 0, 0, 2, 1), panel('b', 2, 0, 1, 1), panel('c', 3, 0, 1, 2), panel('fixed', 1, 1, 1, 1)]);
const sharedResult = dropLayout(shared, shared.panels[0], { x: 2, y: 0, w: 2, h: 2 });
assert.deepEqual(geometry(sharedResult.find(p => p.id === 'b')), [1, 0, 1, 1]);
assert.deepEqual(geometry(sharedResult.find(p => p.id === 'c')), [0, 0, 1, 2], 'coordinate blockers to preserve both sizes');
const full = workspace(Array.from({ length: 8 }, (_, i) => panel(String(i), i % 4, Math.floor(i / 4), 1, 1)));
assert.equal(dropLayout(full, full.panels[0], { x: 0, y: 0, w: 2, h: 1 }), undefined, 'reject a full grid without deleting a panel');
assert.equal(dropLayout(full, moving, { x: 0, y: 0, w: 1, h: 1 }), undefined, 'new panels do not vacate a cell');
assert.equal(dropLayout(full, full.panels[0], { x: -1, y: 0, w: 2, h: 1 }), undefined);
console.log('PASS shared dividers and drop relocation: exact four-cell example, nearest free cell, move/shrink, coordinated blockers and full-grid rejection');

let seed = 12345, checked = 0, slowest = 0;
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
for (const [columns, rows] of [[2, 2], [4, 2], [2, 4], [8, 2]]) for (let sample = 0; sample < 60; sample++) {
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
        for (let h = 1; h <= 2 && y + h <= rows; h++) for (let w = 1; w <= 2 && x + w <= columns; w++) {
            const target = { x, y, w, h }, others = panels.filter(p => p.id !== source.id), fixed = others.filter(p => !intersects(p, target));
            const possible = columns * rows - w * h - fixed.reduce((sum, p) => sum + p.w * p.h, 0) >= others.length - fixed.length;
            const start = performance.now(), result = dropLayout(ws, source, target);
            slowest = Math.max(slowest, performance.now() - start); checked++;
            assert.equal(!!result, possible, JSON.stringify({ ws, source, target }));
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
console.log(`PASS ${checked} generated grid-drop cases across four grids; slowest planning call ${slowest.toFixed(1)}ms`);
