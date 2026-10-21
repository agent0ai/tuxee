import { notify } from './ui';

export class DisplayAudio {
    muted = false;
    private ready = false;
    private context?: AudioContext;
    private socket?: WebSocket;
    private unlock?: AbortController;
    private sources = new Set<AudioBufferSourceNode>();
    private next = 0;

    constructor(private id: () => string | undefined, private owner: HTMLElement) {}

    available(value: boolean) {
        this.ready = value;
        if (value) void this.start();
        else this.close();
    }

    toggle() {
        this.muted = !this.muted;
        if (this.muted) this.close();
        else void this.start();
    }

    private async start() {
        if (!this.ready || this.muted || this.context) return;
        const unlock = this.unlock = new AbortController();
        const fail = (error: unknown) => {
            if (this.unlock !== unlock) return;
            this.muted = true; this.close(); notify(error, this.owner);
        };
        try {
            const context = this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
            const resume = () => { if (context.state === 'suspended') void context.resume().catch(fail); };
            // Autoplay can wait for a gesture after reload; no capture starts until playback is allowed.
            for (const type of ['click', 'keydown']) document.addEventListener(type, resume, { capture: true, signal: unlock.signal });
            await context.resume();
            if (this.context !== context) return;
            unlock.abort();
            const url = new URL(`/api/terminals/${this.id()}/display/audio`, location.href);
            url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = this.socket = new WebSocket(url);
            socket.binaryType = 'arraybuffer';
            socket.onmessage = event => {
                if (this.socket !== socket || context.state !== 'running') return;
                if (!(event.data instanceof ArrayBuffer) || event.data.byteLength !== 3840) { fail('Invalid audio data'); return; }
                // shortcut: PCM costs 1.54 Mbit/s; add compression if bandwidth becomes the constraint.
                const now = context.currentTime;
                if (this.next > now + 0.18) return;
                if (this.next < now + 0.01) this.next = now + 0.12;
                const data = new DataView(event.data), buffer = context.createBuffer(2, 960, 48000);
                for (let channel = 0; channel < 2; channel++) {
                    const samples = buffer.getChannelData(channel);
                    for (let i = 0; i < samples.length; i++) samples[i] = data.getInt16(i * 4 + channel * 2, true) / 32768;
                }
                const source = context.createBufferSource(); source.buffer = buffer;
                source.connect(context.destination); this.sources.add(source);
                source.onended = () => { this.sources.delete(source); source.disconnect(); };
                source.start(this.next); this.next += buffer.duration;
            };
            socket.onclose = () => {
                if (this.socket !== socket) return;
                fail('Sound disconnected');
            };
        } catch (error) { fail(error); }
    }

    close() {
        this.unlock?.abort(); this.unlock = undefined;
        const socket = this.socket; this.socket = undefined; socket?.close();
        for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
        this.sources.clear(); this.next = 0;
        const context = this.context; this.context = undefined; void context?.close();
    }
}
