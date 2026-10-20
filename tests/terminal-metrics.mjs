import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const bundle = await build({
    stdin: { contents: `
        import { Terminal } from '@xterm/xterm';
        import { installTerminalMetrics } from './web/terminal/state';
        window.createTerminal = () => {
            window.term = new Terminal({cols: 179, rows: 12, fontSize: 13, lineHeight: 1, fontFamily: 'monospace'});
            term.open(document.querySelector('#terminal'));
            installTerminalMetrics(term);
        };
    `, resolveDir: process.cwd() },
    bundle: true, platform: 'browser', format: 'iife', write: false,
});
const css = await readFile('node_modules/@xterm/xterm/css/xterm.css', 'utf8');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
    for (const dpr of [1, 1.25, 2]) {
        const context = await browser.newContext({ viewport: { width: 1700, height: 500 }, deviceScaleFactor: dpr });
        const page = await context.newPage();
        await page.setContent(`<style>${css}</style><div id="terminal"></div>`);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.evaluate(() => window.createTerminal());
        for (const font of ['monospace', 'DejaVu Sans Mono', 'Liberation Mono']) {
            const cases = await page.evaluate(async font => {
                const term = window.term;
                term.options.fontFamily = font;
                const results = [];
                for (const cols of [80, 179, 240]) {
                    term.resize(cols, 12); term.reset();
                    const lines = [
                        ' '.repeat(cols - 1),
                        'W'.repeat(cols - 1),
                        '\x1b[1m' + ' '.repeat(cols - 1) + '\x1b[22m',
                        '\x1b[1mBold\x1b[22m' + ' '.repeat(cols - 5),
                        '界e\u0301' + ' '.repeat(cols - 4),
                        '\x1b[3mItalic\x1b[23m' + ' '.repeat(cols - 7),
                    ].map(line => line + '\x1b[35m┃\x1b[0m').join('\r\n');
                    await new Promise(resolve => term.write(lines, resolve));
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    const rows = [...document.querySelector('.xterm-rows').children].slice(0, 6);
                    results.push(rows.map(row => {
                        const bounds = row.getBoundingClientRect(), marker = row.lastElementChild.getBoundingClientRect();
                        return { error: marker.left - bounds.left - bounds.width * (cols - 1) / cols, overflow: marker.right - bounds.right };
                    }));
                }
                return results.flat();
            }, font);
            for (const result of cases) {
                assert.ok(Math.abs(result.error) < .5, `${font}, DPR ${dpr}: shifted scrollbar ${JSON.stringify(result)}`);
                assert.ok(Math.abs(result.overflow) < .5, `${font}, DPR ${dpr}: row does not fit its grid ${JSON.stringify(result)}`);
            }
        }
        await context.close();
    }
    console.log('PASS terminal columns align across spaces, bold/italic, wide/combined glyphs, fonts, widths and DPR 1/1.25/2');
} finally { await browser.close(); }
