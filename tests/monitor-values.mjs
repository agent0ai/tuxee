import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('.test-state', { recursive: true });
await build({ entryPoints: ['web/monitor-values.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/monitor-values.mjs' });
const { compactSize, networkFill } = await import('../.test-state/monitor-values.mjs');
await build({ entryPoints: ['web/ui.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/ui-values.mjs' });
const { size } = await import('../.test-state/ui-values.mjs');
for (const [value, expected] of [
    [528.5390883183117, '529 B'], [910.6452389215688, '911 B'],
    [0, '0 B'], [0.24, '0 B'], [0.5, '1 B'], [42, '42 B'], [1023, '1023 B'],
    [1024, '1.0 KB'], [1536.123456, '1.5 KB'], [1.5 * 1024 ** 2, '1.5 MB'], [1.5 * 1024 ** 3, '1.5 GB'],
]) assert.equal(size(value), expected);
for (const [value, expected] of [
    [2500, '2.5K'], [12000, '12K '], [999000, '999K'], [999, '999B'],
    [16e6, '16M '], [7.8e6, '7.8M'], [999e6, '999M'], [1e9, '1.0G'],
    [0, '0.0B'], [9.94, '9.9B'], [9.95, '10B '], [10, '10B '],
    [999499, '999K'], [999500, '1.0M'], [1e12, '1.0T'],
    [null, '—   '], [undefined, '—   ']
]) {
    assert.equal(compactSize(value), expected);
    assert.equal(compactSize(value).length, 4);
}
const upload = [], download = [];
for (const [value, expected] of [[0, '0.0B'], [1024, '1.0K'], [140 * 1024 ** 2, '140M'], [1.5 * 1024 ** 3, '1.5G'], [999.5 * 1024 ** 2, '1.0G']]) {
    assert.equal(compactSize(value, 1024), expected);
    assert.equal(compactSize(value, 1024).length, 4);
}
for (let i = 0; i < 100; i++) {
    assert.equal(networkFill(20, upload), 1);
    assert.equal(networkFill(2000, download), 1);
}
assert.equal(networkFill(1000, upload), 1, 'spikes fill at most one semicircle');
assert.equal(networkFill(1000, download), 0.5, 'download compares against its own peak');
assert.equal(networkFill(250, upload), 0.25, 'upload compares against its own peak');
for (let i = 0; i < 98; i++) assert.equal(networkFill(20, upload), 0.05, 'nonzero traffic keeps a visible minimum arc');
assert.equal(upload.length, 100);
assert.equal(networkFill(20, upload), 0.08, 'the 101st sample evicts the old spike, leaving the next highest sample');
assert.equal(networkFill(20, upload), 1, 'the next sample evicts the remaining peak');
assert.equal(networkFill(2000, download), 1, 'directions have independent peaks');
assert.equal(networkFill(0, upload), 0);
assert.equal(networkFill(null, upload), 0);
assert.equal(upload.length, 0, 'unavailable/reset counters clear their baseline');
assert.equal(download.length, 100, 'resetting one direction must not clear the other');
assert.equal(networkFill(0, upload), 0);
assert.equal(networkFill(20, upload), 1, 'idle samples do not inflate the peak');
networkFill(1e9, upload);
assert.equal(networkFill(0.001, upload), 0.05, 'even tiny positive rates remain visible after a large spike');
for (let i = 0; i < 100; i++) assert.equal(networkFill(0, upload), 0);
assert.equal(upload.length, 100);
assert.ok(upload.every(value => value === 0), 'idle samples age old peaks out of the window');
assert.equal(networkFill(1, upload), 1);
console.log('PASS rounded byte sizes, fixed-width sizes, independent 100-sample peaks, peak eviction, resets, zero and minimum visible network arcs');
