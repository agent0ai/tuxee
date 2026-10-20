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
assert.equal(dropLayout(blocked, moving, { x: 0, y: 0, w: 2, h: 2 }), undefined);
console.log('PASS shared dividers, junctions, one-cell limits, portrait, obstacles and shrinking drop neighbors');
