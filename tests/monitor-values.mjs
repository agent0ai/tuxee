import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('.test-state', { recursive: true });
await build({ entryPoints: ['web/monitor-values.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/monitor-values.mjs' });
const { compactNumber, compactSize } = await import('../.test-state/monitor-values.mjs');
await build({ entryPoints: ['web/ui.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/ui-values.mjs' });
const { size } = await import('../.test-state/ui-values.mjs');
for (const [value, expected] of [
    [528.5390883183117, '529 B'], [910.6452389215688, '911 B'],
    [0, '0 B'], [0.24, '0 B'], [0.5, '1 B'], [42, '42 B'], [1023, '1023 B'],
    [1024, '1.0 KB'], [1536.123456, '1.5 KB'], [1.5 * 1024 ** 2, '1.5 MB'], [1.5 * 1024 ** 3, '1.5 GB'],
]) assert.equal(size(value), expected);
for (const [value, expected] of [
    [0, '0'], [0.001, '0'], [0.049, '0'], [0.05, '0.1'], [0.099, '0.1'],
    [0.24, '0.2'], [0.5, '0.5'], [1, '1.0'], [1.04, '1.0'], [1.05, '1.1'],
    [1.99, '2.0'], [9, '9.0'], [9.94, '9.9'], [9.95, '10'], [9.99, '10'],
    [10, '10'], [10.49, '10'], [10.5, '11'], [99.9, '100']
]) assert.equal(compactNumber(value), expected);
for (const [value, expected] of [
    [2500, '2.5K'], [12000, '12K'], [999000, '999K'], [999, '999B'],
    [16e6, '16M'], [7.8e6, '7.8M'], [999e6, '999M'], [1e9, '1.0G'],
    [0, '0B'], [0.001, '0B'], [0.24, '0.2B'], [0.5, '0.5B'], [1, '1.0B'], [9.94, '9.9B'], [9.95, '10B'], [10, '10B'],
    [9940, '9.9K'], [9950, '10K'], [10490, '10K'],
    [999499, '999K'], [999500, '1.0M'], [1e12, '1.0T'], [1e15, '1.0P'], [1e18, '1.0E'], [1e21, '1.0Z'],
    [null, '—'], [undefined, '—'], [NaN, '—'], [Infinity, '—'], [-1, '—']
]) assert.equal(compactSize(value), expected);
for (const [value, expected] of [[0, '0B'], [1024, '1.0K'], [140 * 1024 ** 2, '140M'], [1.5 * 1024 ** 3, '1.5G'], [999.5 * 1024 ** 2, '1.0G'], [1024 ** 7, '1.0Z']]) {
    assert.equal(compactSize(value, 1024), expected);
}
for (const [value, expected] of [[0, '0 B'], [1536, '1.5 KB'], [12 * 1024, '12 KB'], [1.5 * 1024 ** 3, '1.5 GB'], [1024 ** 4, '1.0 TB']]) {
    assert.equal(compactSize(value, 1024, true), expected);
}
console.log('PASS monitor decimals below ten, zero rounding, sizes through Z, unit boundaries, unavailable values, detailed byte precision and full-unit properties');
