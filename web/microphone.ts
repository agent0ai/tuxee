import workletURL from './microphone.worklet.js';
import { errorText, t } from './i18n';
import { notify } from './ui';

class Microphone {
    volume = 0;
    lastVolume = 100;
    available = false;
    onchange = () => {};
    private pending?: AbortController;
    private stream?: MediaStream;
    private context?: AudioContext;
    private gain?: GainNode;
    private socket?: WebSocket;

    setVolume(value: number) {
        this.volume = Math.max(0, Math.min(100, value));
        if (!this.volume) { this.close(); return; }
        this.lastVolume = this.volume;
        this.onchange();
        if (this.gain) this.gain.gain.setTargetAtTime(this.volume / 100, this.context!.currentTime, .01);
        if (!this.pending) void this.start();
    }

    private async start() {
        const pending = this.pending = new AbortController();
        const current = () => this.pending === pending;
        const fail = (error: unknown) => { if (current()) { this.close(); notify(error); } };
        try {
            if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error(t('audio.microphoneHTTPS'));
            if (!this.available) throw Error(t('backend.audio.audioRuntimeIsUnavailable'));
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, autoGainControl: false, noiseSuppression: false }, video: false });
            if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
            this.stream = stream;
            for (const track of stream.getTracks()) track.addEventListener('ended', () => fail(t('audio.microphoneStopped')), { signal: pending.signal });
            const timeout = setTimeout(() => fail(t('audio.microphoneStopped')), 10000);
            pending.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
            const context = this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
            await context.resume();
            if (!current()) return;
            await context.audioWorklet.addModule(workletURL);
            if (!current()) return;
            const source = context.createMediaStreamSource(stream), gain = this.gain = context.createGain();
            gain.gain.value = this.volume / 100;
            const processor = new AudioWorkletNode(context, 'tuxee-microphone', { channelCount: 1, channelCountMode: 'explicit' });
            processor.onprocessorerror = () => fail(t('audio.microphoneStopped'));
            const url = new URL('api/microphone', location.href);
            url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = this.socket = new WebSocket(url);
            pending.signal.addEventListener('abort', () => processor.port.close(), { once: true });
            socket.onmessage = event => {
                if (!current()) return;
                try {
                    const message = JSON.parse(event.data);
                    if (!message.ready) { fail(errorText(message)); return; }
                    clearTimeout(timeout);
                    source.connect(gain); gain.connect(processor); processor.connect(context.destination);
                    socket.onmessage = event => { if (current()) { try { fail(errorText(JSON.parse(event.data))); } catch { fail(t('audio.invalidData')); } } };
                } catch { fail(t('audio.invalidData')); }
            };
            processor.port.onmessage = event => {
                if (!current()) return;
                if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 19200 || context.currentTime - event.data.time > .2) {
                    fail(t('audio.microphoneStopped')); return;
                }
                socket.send(event.data.pcm);
                processor.port.postMessage(null);
            };
            socket.onerror = socket.onclose = () => fail(t('audio.microphoneStopped'));
        } catch (error) { fail(error); }
    }

    close() {
        this.pending?.abort(); this.pending = undefined;
        this.socket?.close(); this.socket = undefined;
        this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
        void this.context?.close(); this.context = undefined; this.gain = undefined;
        this.volume = 0; this.onchange();
    }
}

export const microphone = new Microphone();
