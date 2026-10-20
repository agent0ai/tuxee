import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('.test-state', { recursive: true });
await build({ entryPoints: ['web/monitor-values.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/monitor-values.mjs' });
const { compactSize, networkFill } = await import('../.test-state/monitor-values.mjs');
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
for (let i = 0; i < 100; i++) {
    assert.equal(networkFill(20, upload), 0.5);
    assert.equal(networkFill(2000, download), 0.5);
}
assert.equal(networkFill(1000, upload), 1, 'spikes fill at most one semicircle');
for (let i = 0; i < 99; i++) networkFill(20, upload);
assert.equal(upload.length, 100);
assert.equal(networkFill(20, upload), 0.5, 'the 101st sample evicts the old spike');
assert.equal(networkFill(2000, download), 0.5, 'directions have independent averages');
assert.equal(networkFill(0, upload), 0);
assert.equal(networkFill(null, upload), 0);
assert.equal(upload.length, 0, 'unavailable/reset counters clear their baseline');
assert.equal(networkFill(0, upload), 0);
assert.equal(networkFill(20, upload), 1, 'idle samples contribute to the average');
console.log('PASS fixed-width compact sizes and independent 100-sample network gauges');
