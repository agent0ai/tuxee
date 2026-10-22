import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('.test-state', { recursive: true });
await build({ entryPoints: ['web/monitor-values.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/monitor-values.mjs' });
const { compactSize } = await import('../.test-state/monitor-values.mjs');
await build({ entryPoints: ['web/ui.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/ui-values.mjs' });
const { size } = await import('../.test-state/ui-values.mjs');
for (const [value, expected] of [
    [528.5390883183117, '529 B'], [910.6452389215688, '911 B'],
    [0, '0 B'], [0.24, '0 B'], [0.5, '1 B'], [42, '42 B'], [1023, '1023 B'],
    [1024, '1.0 KB'], [1536.123456, '1.5 KB'], [1.5 * 1024 ** 2, '1.5 MB'], [1.5 * 1024 ** 3, '1.5 GB'],
]) assert.equal(size(value), expected);
for (const [value, expected] of [
    [2500, '3K'], [12000, '12K'], [999000, '999K'], [999, '999B'],
    [16e6, '16M'], [7.8e6, '8M'], [999e6, '999M'], [1e9, '1G'],
    [0, '0B'], [0.24, '0B'], [0.5, '1B'], [9.94, '10B'], [10, '10B'],
    [999499, '999K'], [999500, '1M'], [1e12, '1T'], [1e15, '1P'], [1e18, '1E'], [1e21, '1Z'],
    [null, '—'], [undefined, '—'], [NaN, '—'], [Infinity, '—'], [-1, '—']
]) assert.equal(compactSize(value), expected);
for (const [value, expected] of [[0, '0B'], [1024, '1K'], [140 * 1024 ** 2, '140M'], [1.5 * 1024 ** 3, '2G'], [999.5 * 1024 ** 2, '1G'], [1024 ** 7, '1Z']]) {
    assert.equal(compactSize(value, 1024), expected);
}
console.log('PASS integer monitor sizes through Z, rounding and unit boundaries, unavailable values and detailed byte precision');
