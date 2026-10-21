import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const result = await build({
    stdin: { contents: "import RFB from './web/vendor/novnc/core/rfb.js'; window.ResizeRFB = RFB; import { supportsWebCodecsH264Decode } from './web/vendor/novnc/core/util/browser.js'; window.probeSupported = supportsWebCodecsH264Decode;", resolveDir: process.cwd() },
    bundle: true, format: 'esm', write: false,
});
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
    for (const mode of ['success', 'closed-error', 'configure-error']) {
        const page = await browser.newPage();
        await page.evaluate(mode => {
            window.probe = { framesClosed: 0, decoderClosed: false, closeCalls: 0 };
            window.VideoDecoder = class {
                static async isConfigSupported() { return { supported: true }; }
                state = 'unconfigured';
                constructor(callbacks) { this.callbacks = callbacks; }
                configure() { if (mode === 'configure-error') throw Error('configuration failed'); this.state = 'configured'; }
                decode() {}
                async flush() {
                    if (mode === 'closed-error') { this.state = 'closed'; window.probe.decoderClosed = true; throw Error('decoder failed'); }
                    this.callbacks.output({ close() { window.probe.framesClosed++; } });
                }
                close() {
                    if (this.state === 'closed') throw Error('double close');
                    this.state = 'closed'; window.probe.decoderClosed = true; window.probe.closeCalls++;
                }
            };
            window.EncodedVideoChunk = class {};
        }, mode);
        await page.addScriptTag({ type: 'module', content: result.outputFiles[0].text });
        await page.waitForFunction(() => typeof window.probeSupported === 'boolean');
        assert.deepEqual(await page.evaluate(() => ({ ...window.probe, supported: window.probeSupported })), {
            framesClosed: mode === 'success' ? 1 : 0,
            decoderClosed: true, closeCalls: mode === 'closed-error' ? 0 : 1,
            supported: mode === 'success',
        });
        assert.deepEqual(await page.evaluate(() => {
            const calls = [], RFB = window.ResizeRFB;
            RFB.messages.setDesktopSize = (_, width, height) => calls.push([width, height]);
            const view = { _resizeSession: true, _viewOnly: false, _supportsSetDesktopSize: true, _pendingRemoteResize: false, _lastResize: 0, _fbWidth: 100, _fbHeight: 100 };
            for (const [w, h] of [[0, 0], [800, 0], [0, 600], [.5, 600], [70000, 600]]) {
                view._screenSize = () => ({ w, h });
                RFB.prototype._requestRemoteResize.call(view);
                if (view._pendingRemoteResize) throw Error('invalid resize became pending');
            }
            view._screenSize = () => ({ w: 800, h: 600 });
            RFB.prototype._requestRemoteResize.call(view);
            return calls;
        }), [[800, 600]]);
        await page.close();
    }
} finally { await browser.close(); }
console.log('PASS noVNC decoder cleanup and valid framebuffer sizes for hidden/visible viewers');
