import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
await mkdir('.test-state', { recursive: true });
await build({ entryPoints: ['web/process-tree.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/process-tree.mjs' });
const { selectProcess, selectionRoots } = await import('../.test-state/process-tree.mjs');
const row = (id, parentID = '', canSignal = true) => ({ id, parentID, canSignal });
const rows = [row('root', '', false), row('parent', 'root'), row('child', 'parent'), row('grandchild', 'child'), row('sibling', 'parent'), row('group', 'parent')];
const selected = new Set();
selectProcess(rows, selected, 'parent', true);
assert.deepEqual([...selected].sort(), ['child', 'grandchild', 'group', 'parent', 'sibling']);
assert.deepEqual(selectionRoots(rows, selected).map(r => r.id), ['parent']);
selectProcess(rows, selected, 'grandchild', false);
assert.deepEqual([...selected].sort(), ['group', 'sibling']);
assert.deepEqual(selectionRoots(rows, selected).map(r => r.id), ['sibling', 'group']);
selectProcess(rows, selected, 'parent', true); selectProcess(rows, selected, 'parent', false); assert.equal(selected.size, 0);
const fixtures = JSON.parse(await readFile('.test-state/process-fixtures.json', 'utf8'));
for (const fixture of Object.values(fixtures)) {
 const chosen = new Set();
 for (const node of fixture.rows) if (node.canSignal) selectProcess(fixture.rows, chosen, node.id, true);
 const roots = selectionRoots(fixture.rows, chosen);
 assert.equal(new Set(roots.map(r => r.id)).size, roots.length);
 for (const node of roots) selectProcess(fixture.rows, chosen, node.id, false);
 assert.equal(chosen.size, 0);
}
console.log('PASS hierarchical selection, ancestor deselection, grouped targets and synthetic trees');
