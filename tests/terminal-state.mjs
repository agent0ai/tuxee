import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('.test-state', { recursive: true });
await build({ stdin: { contents: `
    export { TerminalEngine } from './web/terminal/engine';
    export { restoreTerminal, validateSnapshot } from './web/terminal/state';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/terminal-state.mjs' });
const { TerminalEngine, restoreTerminal, validateSnapshot } = await import('../.test-state/terminal-state.mjs');
const encode = text => new TextEncoder().encode(text);
const engine = new TerminalEngine({ columns: 80, rows: 24 });
let base;
try {
    await engine.apply({ data: encode('Snapshot validation fixture\r\n') });
    base = await engine.capture();
} finally { await engine.close(); }
assert.deepEqual(base, JSON.parse(JSON.stringify(base)), 'capture returns plain JSON without undefined fields');
assert.doesNotThrow(() => validateSnapshot(base));

for (const value of [-1, 2 ** 32, 0.5, NaN, Infinity, undefined, null, true, '0', {}, [], 1n]) {
    const snapshot = structuredClone(base);
    snapshot.normal.lines[0].data[0] = value;
    assert.throws(() => validateSnapshot(snapshot), `reject invalid cell ${String(value)}`);
}
for (const value of [0, -0, 0xffff_ffff]) {
    const snapshot = structuredClone(base);
    snapshot.normal.lines[0].data[0] = value;
    assert.doesNotThrow(() => validateSnapshot(snapshot));
}
const invalid = [
    ['sparse first cell', s => { delete s.normal.lines[0].data[0]; }],
    ['sparse last cell', s => { delete s.normal.lines[0].data[239]; }],
    ['cell count', s => s.normal.lines[0].data.pop()],
    ['line length', s => s.normal.lines[0].length = 501],
    ['history bound', s => s.normal.lines = Array(6000).fill(s.normal.lines[0])],
    ['cursor bound', s => s.normal.geometry.x = -1],
    ['wrapped flag', s => s.normal.lines[0].wrapped = 1],
    ['combined text', s => s.normal.lines[0].combined['0'] = 4],
    ['extended attributes', s => s.normal.lines[0].extended['0'] = { ext: -1, url: 0 }],
    ['parser state', s => s.utf8Interim = []],
    ['palette', s => s.palette.colors = []],
    ['forbidden key', s => s.extra = { constructor: 0 }],
    ['nonplain metadata', s => s.extra = new Date()],
    ['text budget', s => s.extra = 'x'.repeat((12 << 20) + 1)],
    ['cell node budget', s => s.extra = Array(13000).fill(s.normal.lines[0].data)],
    ['cell depth budget', s => {
        let cursor = s;
        for (let i = 0; i < 32; i++) cursor = cursor.extra = {};
        cursor.extra = s.normal.lines[0].data;
    }],
];
for (const [name, edit] of invalid) {
    const snapshot = structuredClone(base); edit(snapshot);
    assert.throws(() => validateSnapshot(snapshot), name);
}
console.log('PASS snapshot cell validation, sparse entries, metadata and structural/text bounds');

const fixtures = [
    [encode('\x1b[31mcolor\x1b[0m\x1b(0lqqk\x1b7\x1b(B\x1b]2;partial'), encode(' title\x1b\\\x1b8qq\x1b(B\r\nfinish')],
    [new Uint8Array([...encode('unicode '), 0xf0, 0x9f]), new Uint8Array([0x91, 0x8b, ...encode(' e\u0301\r\n')])],
    [encode('\x1b]8;;https://example.invalid\x1b\\linked\x1b]8;;\x1b\\\x1b[?1049h\x1b[3;'), encode('9Halt\x1b[?1049l\x1b]4;2;rgb:11/22/33\x1b\\done')],
    [encode('\x1bP1;2qpartial'), encode(' data\x1b\\after DCS')],
];
for (const [start, tail] of fixtures) {
    const source = new TerminalEngine({ columns: 80, rows: 24 });
    const restored = new TerminalEngine({ columns: 80, rows: 24 });
    try {
        await source.apply({ data: start });
        const snapshot = await source.capture(), before = structuredClone(snapshot);
        assert.deepEqual(snapshot, JSON.parse(JSON.stringify(snapshot)));
        await source.apply({ data: tail });
        assert.deepEqual(snapshot, before, 'later output cannot mutate a captured snapshot');
        restoreTerminal(restored.terminal, snapshot);
        await restored.apply({ data: tail });
        assert.deepEqual(await restored.capture(), await source.capture(), 'restored parsing must continue identically');
    } finally { await source.close(); await restored.close(); }
}
console.log('PASS detached snapshots and Unicode/OSC/CSI/DCS, charset, link, palette and alternate-screen continuation');
