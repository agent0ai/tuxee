import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const bundle = await build({
    stdin: { contents: `
        import { Terminal } from '@xterm/xterm';
        import { installTerminalMetrics, installTerminalUnicode, installTerminalView, installTerminalResize, restoreTerminal, terminalDimensions } from './web/terminal/state';
        import { TerminalEngine } from './web/terminal/engine';
        window.terminalDimensions = terminalDimensions;
        window.restoreTerminal = restoreTerminal;
        window.canonical = async (text, cols, rows) => {
            const engine = new TerminalEngine({columns:cols,rows});
            await engine.apply({data:new TextEncoder().encode(text)});
            const snapshot = await engine.capture();
            await engine.close(); return snapshot;
        };
        window.createTerminal = () => {
            window.term = new Terminal({cols: 179, rows: 12, fontSize: 13, lineHeight: 1, fontFamily: 'monospace', allowProposedApi: true});
            installTerminalUnicode(term);
            term.open(document.querySelector('#terminal'));
            installTerminalView(term);
            installTerminalMetrics(term);
            window.resizeDisplay = installTerminalResize(term);
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
        for (const detached of [false, true]) {
            const error = await page.evaluate(async detached => {
                const host = document.querySelector('#terminal');
                if (detached) host.remove(); else host.hidden = true;
                term.options.fontFamily = detached ? 'monospace' : 'Liberation Mono';
                if (detached) document.body.append(host); else host.hidden = false;
                await new Promise(resolve => term.write('\r\nMeasured after showing', resolve));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const row = host.querySelector('.xterm-rows > div'), style = getComputedStyle(row);
                const text = document.createElement('pre');
                Object.assign(text.style, { fontFamily: style.fontFamily, fontSize: style.fontSize, letterSpacing: style.letterSpacing });
                text.textContent = 'W'.repeat(term.cols); document.body.append(text);
                const range = document.createRange(); range.selectNodeContents(text);
                const error = range.getBoundingClientRect().width - row.getBoundingClientRect().width;
                text.remove(); return error;
            }, detached);
            assert.ok(Math.abs(error) < .5, `DPR ${dpr}, ${detached ? 'detached' : 'hidden'} font measurement leaves stale row spacing: ${error}`);
        }
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
                        '👋' + ' '.repeat(cols - 3),
                        '👍' + ' '.repeat(cols - 3),
                        '█▀▄▌▐▖▗▘▝▚▞' + ' '.repeat(cols - 12),
                        '\x1b[3mItalic\x1b[23m' + ' '.repeat(cols - 7),
                    ].map(line => line + '\x1b[35m┃\x1b[0m').join('\r\n');
                    await new Promise(resolve => term.write(lines, resolve));
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    const rows = [...document.querySelector('.xterm-rows').children].slice(0, lines.split('\r\n').length);
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
            const blockRect = await page.evaluate(async () => {
                const term = window.term;
                term.resize(40, 12); term.reset();
                await new Promise(resolve => term.write('\x1b[?25l\x1b[38;2;255;255;255m\x1b[48;2;0;0;0m' + ['████', '████', '████', '▀▄▌▐▖▗▘▝▚▞'].join('\r\n'), resolve));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                term.select(0, 0, 4); const selected = term.getSelection(); term.clearSelection();
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const rows = document.querySelector('.xterm-rows').children;
                const first = rows[0].getBoundingClientRect(), last = rows[2].getBoundingClientRect();
                const shapes = rows[3].getBoundingClientRect();
                return {x: first.left + first.width / term.cols / 2, top: first.top, bottom: last.bottom, selected,
                    boundaries: [rows[1], rows[2]].map(row => row.getBoundingClientRect().top),
                    shapes: {x: shapes.left, y: shapes.top, height: shapes.height, cell: shapes.width / term.cols}};
            });
            assert.equal(blockRect.selected, '████', 'geometric blocks must preserve copy/selection text');
            const pixels = await page.evaluate(async ({png, rect}) => {
                const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
                const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
                const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
                const gaps = [];
                for (let y = Math.ceil(rect.top * devicePixelRatio); y < Math.floor(rect.bottom * devicePixelRatio); y++) {
                    const pixel = ctx.getImageData(Math.floor(rect.x * devicePixelRatio), y, 1, 1).data;
                    // Fractional scale antialiases row boundaries; font gaps leave empty pixel rows.
                    const boundary = rect.boundaries.some(top => y === Math.floor(top * devicePixelRatio));
                    const minimum = boundary && devicePixelRatio % 1 ? 64 : 255;
                    if (pixel[0] < minimum || pixel[1] < minimum || pixel[2] < minimum) gaps.push([y, ...pixel]);
                }
                const quadrants = Array.from({length:10}, (_, i) => [[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y]) => {
                    const pixel = ctx.getImageData(Math.floor((rect.shapes.x + (i+x)*rect.shapes.cell)*devicePixelRatio),
                        Math.floor((rect.shapes.y + y*rect.shapes.height)*devicePixelRatio), 1, 1).data;
                    return pixel[0] > 128 ? 1 : 0;
                }));
                return {gaps, quadrants};
            }, {png: (await page.screenshot()).toString('base64'), rect: blockRect});
            assert.deepEqual(pixels.gaps, [], `${font}, DPR ${dpr}: full blocks must join vertically without font gaps`);
            assert.deepEqual(pixels.quadrants, [
                [1,1,0,0], [0,0,1,1], [1,0,1,0], [0,1,0,1], [0,0,1,0],
                [0,0,0,1], [1,0,0,0], [0,1,0,0], [1,0,0,1], [0,1,1,0],
            ], 'half blocks and quadrant blocks must preserve their shapes');
        }
        const frames = await page.evaluate(async () => {
            const term = window.term;
            term.resize(80, 12); term.reset(); term.options.cursorBlink = false; term.focus();
            const write = data => new Promise(resolve => term.write(data, resolve));
            const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await write('\x1b[?1049h\x1b[2J\x1b[H'); await paint();
            await write('\x1b[?2026h\x1b[?25l\x1b[HCOMPLETE\x1b[?25h\x1b[?2026l' +
                '\x1b[?2026h\x1b[?25l\x1b[H\x1b[2KINCOMPLETE');
            await paint();
            const read = () => ({text:document.querySelector('.xterm-rows').textContent, cursors:document.querySelectorAll('.xterm-cursor').length});
            const completed = read();
            await write('\x1b[?25h\x1b[?20'); await paint(); const split = read();
            await write('26l'); await paint(); const finished = read();
            const outgoing = []; const listener = term.onData(data => outgoing.push(data));
            await write('\x1b[6n\x1b[c'); term.input('\x01'); listener.dispose();
            return {completed,split,finished,outgoing};
        });
        assert.ok(frames.completed.text.includes('COMPLETE') && !frames.completed.text.includes('INCOMPLETE'), 'adjacent synchronized frames must paint the completed frame immediately');
        assert.equal(frames.completed.cursors, 1, 'completed frame must retain its visible cursor');
        assert.deepEqual(frames.split, frames.completed, 'split DEC 2026 terminator must not expose an intermediate frame');
        assert.ok(frames.finished.text.includes('INCOMPLETE'));
        assert.equal(frames.finished.cursors, 1);
        assert.deepEqual(frames.outgoing, ['\x01'], 'view suppresses terminal query replies while preserving keyboard input');
        if (dpr === 1) {
            const holds = await page.evaluate(async () => {
                const write = data => new Promise(resolve => term.write(data, resolve));
                const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
                const text = () => document.querySelector('.xterm-rows').textContent;
                await write('\x1b[?1049l\x1b[2J\x1b[HOLD'); await pause(50);
                resizeDisplay.begin(); term.resize(70, 10);
                await write('\x1b[?25;2026h\x1b[2J\x1b[HCOMPLETE');
                await pause(1100);
                await write('\x1b[?25l'); // Unused parser parameter slots must not look like a frame end.
                const beforeEnd = text();
                await write('\x1b[?2026l\x1b[?2026h\x1b[2J\x1b[HNEXT');
                await pause(50);
                const adjacent = text();
                await write('\x1b[?2026l'); await pause(50);
                const next = text();
                resizeDisplay.begin(); term.resize(60, 9);
                await write('\x1b[2J\x1b[HNO_MARKERS');
                const quietBefore = text(); await pause(180); const quietAfter = text();
                resizeDisplay.begin(); term.resize(65, 11);
                await pause(350);
                const silentRows = document.querySelector('.xterm-rows').children.length;
                await write('\x1b[3J\x1b[2J\x1b[H');
                await write('\x1b[?2026hLATE_COMPLETE');
                await pause(1100); const lateBefore = text();
                await write('\x1b[?2026l'); const lateAfter = text();
                resizeDisplay.begin();
                const started = performance.now();
                await write('\x1b[?2026h\x1b[2J\x1b[HMISSING_END');
                await pause(1100); const deadlineBefore = text();
                await pause(Math.max(0, 5150 - (performance.now()-started)));
                const deadlineAfter = text();
                await write('\x1b[?2026l');
                resizeDisplay.begin(); await write('\x1b[2J\x1b[HRELEASED');
                resizeDisplay.release();
                await write('\x1b[3J\x1b[2J\x1b[HRELEASED'); await pause(50);
                const released = text();
                term.element.style.display = 'none'; await pause(100);
                resizeDisplay.begin(); term.resize(72,13);
                await write('\x1b[?2026h\x1b[2J\x1b[HHIDDEN_COMPLETE\x1b[?2026l');
                term.element.style.display = ''; await pause(150);
                const hidden = {rows:document.querySelector('.xterm-rows').children.length,text:text()};
                return {beforeEnd,adjacent,next,quietBefore,quietAfter,silentRows,lateBefore,lateAfter,deadlineBefore,deadlineAfter,released,hidden};
            });
            assert.ok(holds.beforeEnd.includes('OLD') && !holds.beforeEnd.includes('COMPLETE'));
            assert.ok(holds.adjacent.includes('COMPLETE') && !holds.adjacent.includes('NEXT'), 'late end followed by another begin reveals exactly the completed frame');
            assert.ok(holds.next.includes('NEXT'));
            assert.ok(!holds.quietBefore.includes('NO_MARKERS') && holds.quietAfter.includes('NO_MARKERS'));
            assert.equal(holds.silentRows,11,'silent resize releases without waiting for output');
            assert.ok(holds.lateBefore.includes('NO_MARKERS') && holds.lateAfter.includes('LATE_COMPLETE'),'a late scrollback rebuild still presents atomically');
            assert.ok(!holds.deadlineBefore.includes('MISSING_END') && holds.deadlineAfter.includes('MISSING_END'),'missing terminator cannot hold the display indefinitely');
            assert.ok(holds.released.includes('RELEASED'),'explicit release paints the latest parsed state');
            assert.ok(holds.hidden.rows === 13 && holds.hidden.text.includes('HIDDEN_COMPLETE'),'hidden views restore the final geometry and frame');
            console.log('PASS resize presentation: late/adjacent frame boundaries, unmarked output, silent apps, bounded missing-end fallback and explicit release');
            const scrolling = await page.evaluate(async () => {
                const write = data => new Promise(resolve => term.write(data, resolve));
                const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const position = () => ({base:term.buffer.active.baseY, view:term.buffer.active.viewportY});
                resizeDisplay.release(); term.reset(); term.resize(80, 12);
                await write('HISTORY\r\n'.repeat(100)); await paint();
                term.scrollLines(-10); await paint();
                const before = position();
                await write('MORE\r\n'.repeat(5)); await paint();
                const reading = position();
                resizeDisplay.begin(); term.resize(70, 10);
                await write('\x1b[?2026h\x1b[3J\x1b[2J\x1b[H' + 'REBUILT\r\n'.repeat(200));
                // TerminalView releases onData, after xterm's automatic scroll-on-input.
                const input = term.onData(() => resizeDisplay.release());
                term.input('x'); input.dispose();
                await write('\x1b[?2026lAFTER_INPUT\r\n'); await paint();
                const afterInput = position();
                resizeDisplay.begin(); term.resize(80, 12);
                await write('\x1b[?2026h\x1b[3J\x1b[2J\x1b[H' + 'FOLLOW\r\n'.repeat(250));
                term.scrollLines(-10); await paint();
                const duringRedraw = position();
                await write('\x1b[?2026lMORE\r\n'); await paint();
                const afterScroll = position();
                term.scrollToBottom(); await paint();
                resizeDisplay.begin(); term.resize(75, 11);
                await write('\x1b[?2026h\x1b[3J\x1b[2J\x1b[H' + 'FOLLOW\r\n'.repeat(100) + '\x1b[?2026l');
                await paint();
                return {before,reading,afterInput,duringRedraw,afterScroll,following:position()};
            });
            assert.equal(scrolling.reading.view, scrolling.before.view, 'output preserves deliberate scrollback');
            assert.equal(scrolling.afterInput.view, scrolling.afterInput.base, 'typing during redraw must use the rebuilt scroll range');
            assert.equal(scrolling.duringRedraw.view, scrolling.duringRedraw.base - 10, 'scrolling during redraw starts from the current buffer');
            assert.equal(scrolling.afterScroll.view, scrolling.duringRedraw.view, 'redraw completion preserves deliberate scrolling');
            assert.equal(scrolling.following.view, scrolling.following.base, 'redrawing at the bottom keeps following output');
            console.log('PASS redraw scroll range, scroll-on-input and preserved intentional scrollback');
        }
        await page.evaluate(async () => {
            const snapshot = await window.canonical('\x1b[?1049h\x1b[48;2;17;25;39m👋' + ' '.repeat(94) + '\r\n👍' + ' '.repeat(94), 96, 25);
            window.restoreTerminal(window.term, snapshot);
        });
        assert.deepEqual(await page.evaluate(() => [0, 1].map(y => {
            const line = window.term.buffer.active.getLine(y);
            return [line.getCell(0).getWidth(), line.getCell(95).getBgColor()];
        })), [[2, 0x111927], [2, 0x111927]], 'canonical snapshots must preserve both emoji columns and the last background cell');
        for (const width of [360, 900]) {
            await page.locator('#terminal').evaluate((node, width) => {
                node.style.cssText = `width:${width}px;height:300px`;
                node.querySelector('.xterm').style.cssText += ';height:100%;box-sizing:border-box;padding:2px 5px 0';
                const dimensions = window.terminalDimensions(window.term);
                window.term.resize(dimensions.cols, dimensions.rows);
            }, width);
            const room = await page.evaluate(() => {
                const term = document.querySelector('.xterm'), screen = document.querySelector('.xterm-screen');
                const padding = parseFloat(getComputedStyle(term).paddingRight);
                return {gap:term.getBoundingClientRect().right - padding - screen.getBoundingClientRect().right, cell:screen.getBoundingClientRect().width/window.term.cols};
            });
            assert.ok(room.gap >= -.5 && room.gap < room.cell + .5, `right edge reserves no scrollbar gutter: ${JSON.stringify(room)}`);
        }
        if (process.argv[2] && dpr === 2) {
            const recording = await readFile(process.argv[2], 'utf8');
            const cols = Number(recording.match(/COLUMNS="(\d+)"/)[1]), rows = Number(recording.match(/LINES="(\d+)"/)[1]);
            const output = recording.slice(recording.indexOf('\n') + 1);
            const end = output.indexOf('\x1b[H', output.indexOf('\x1b[H\r') + 4);
            await page.setViewportSize({width:1000,height:1000});
            await page.locator('#terminal').evaluate(node => { node.style.cssText = ''; node.querySelector('.xterm').style.padding = '0'; });
            await page.evaluate(async ({text,cols,rows}) => {
                window.term.options.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
                window.restoreTerminal(window.term, await window.canonical(text,cols,rows));
            }, {text:output.slice(0,end),cols,rows});
            await page.waitForTimeout(100);
            assert.deepEqual(await page.evaluate(() => [8,11].map(y=>window.term.buffer.active.getLine(y).getCell(95).getBgColor())), [0x111927,0x111927]);
            await mkdir('test-results', {recursive:true});
            await page.locator('.xterm-screen').screenshot({path:'test-results/spynel-replay-fixed.png'});
        }
        await context.close();
    }
    console.log('PASS synchronized frames/cursor, query isolation, column widths, emoji/snapshot backgrounds, block geometry, copied text and fitting without a scrollbar gutter across fonts and DPR 1/1.25/2');
} finally { await browser.close(); }
