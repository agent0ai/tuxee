import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const packets = [];
let Processor;
const scope = vm.createContext({ currentTime: 0, AudioWorkletProcessor: class {
    port = { postMessage: packet => packets.push(packet) };
}, registerProcessor: (_, value) => { Processor = value; } });
vm.runInContext(await readFile('web/microphone.worklet.js', 'utf8'), scope);
const processor = new Processor();
for (let block = 0; block < 375; block++) {
    scope.currentTime = block * 128 / 48000;
    processor.process([[Float32Array.from({ length: 128 }, (_, i) => Math.sin((block * 128 + i) / 40))]]);
    if (processor.pending) processor.port.onmessage();
}
assert.equal(packets.length, 50, '128-sample render blocks must not lose samples at packet boundaries');
for (const [packet, { pcm }] of packets.entries()) {
    assert.equal(pcm.byteLength, 1920);
    const data = new DataView(pcm);
    for (let i = 0; i < 960; i++) assert.ok(Math.abs(data.getInt16(i * 2, true) - Math.round(Math.sin((packet * 960 + i) / 40) * 32767)) <= 1);
}
packets.length = 0;
for (let block = 0; block < 1000; block++) processor.process([[new Float32Array(128)]]);
assert.equal(packets.length, 10, 'a stalled page must not grow the message queue');
console.log('PASS microphone PCM samples, packet boundaries and bounded worklet queue');
