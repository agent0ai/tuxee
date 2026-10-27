import { t } from './i18n';
import { button, el, icon, notify, popover } from './ui';

let volume = 100, lastVolume = 100;

export function audioControl() {
    let close = () => {};
    const slider = el('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
    slider.setAttribute('aria-label', t("audio.audioVolume"));
    slider.setAttribute('aria-orientation', 'vertical');
    const setVolume = (value: number) => {
        volume = value;
        if (volume > 0) lastVolume = volume;
        audio.updateVolume();
        update();
    };
    const mute = button(t("audio.muteAudio"), 'VolumeX', () => setVolume(volume > 0 ? 0 : lastVolume));
    const control = button(t("audio.audio"), 'Volume2', () => {
        if (control.getAttribute('aria-expanded') === 'true') { close(); return; }
        const content = el('div', 'volume-popover');
        content.setAttribute('role', 'dialog'); content.setAttribute('aria-label', t("audio.audio"));
        content.style.height = `${control.closest('header')!.getBoundingClientRect().height * 4}px`;
        content.append(slider, mute);
        ({ close } = popover(control, content));
    }, 'volume-toggle');
    control.setAttribute('aria-haspopup', 'dialog'); control.setAttribute('aria-expanded', 'false');
    const update = () => {
        const name = volume === 0 ? 'VolumeX' : volume <= 50 ? 'Volume1' : 'Volume2';
        control.replaceChildren(icon(name));
        control.title = volume === 0 ? t("audio.audioMuted") : t("audio.percent", { volume });
        control.setAttribute('aria-label', control.title);
        slider.value = String(volume); slider.setAttribute('aria-valuetext', `${volume}%`);
        mute.classList.toggle('active', volume === 0);
        mute.setAttribute('aria-pressed', String(volume === 0));
        mute.title = volume > 0 ? t("audio.muteAudio") : t("audio.unmuteAudio");
        mute.setAttribute('aria-label', mute.title);
    };
    slider.oninput = () => setVolume(slider.valueAsNumber);
    update();
    return { control, dispose: () => close() };
}

class UserAudio {
    private failed = false;
    private ready = false;
    private context?: AudioContext;
    private gain?: GainNode;
    private socket?: WebSocket;
    private unlock?: AbortController;
    private sources = new Set<AudioBufferSourceNode>();
    private next = 0;
    private position?: number;

    available(value: boolean) {
        this.ready = value;
        this.failed = false;
        if (value) void this.start();
        else this.close();
    }

    updateVolume() {
        this.failed = false;
        if (volume === 0) this.close();
        else {
            if (this.gain) this.gain.gain.setTargetAtTime(volume / 100, this.context!.currentTime, 0.01);
            void this.start();
        }
    }

    private async start() {
        if (!this.ready || volume === 0 || this.failed || this.context) return;
        const unlock = this.unlock = new AbortController();
        const fail = (error: unknown) => {
            if (this.unlock !== unlock) return;
            this.failed = true; this.close(); notify(error);
        };
        try {
            const context = this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
            const gain = this.gain = context.createGain();
            gain.gain.value = volume / 100; gain.connect(context.destination);
            const resume = () => { if (context.state === 'suspended') void context.resume().catch(fail); };
            // Autoplay can wait for a gesture after reload; no capture starts until playback is allowed.
            for (const type of ['click', 'keydown']) document.addEventListener(type, resume, { capture: true, signal: unlock.signal });
            await context.resume();
            if (this.context !== context) return;
            unlock.abort();
            const url = new URL('/api/audio', location.href);
            url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = this.socket = new WebSocket(url);
            socket.binaryType = 'arraybuffer';
            socket.onmessage = event => {
                if (this.socket !== socket || context.state !== 'running') return;
                if (!(event.data instanceof ArrayBuffer) || event.data.byteLength !== 3848) { fail(t("audio.invalidData")); return; }
                const data = new DataView(event.data), position = Number(data.getBigUint64(0, true));
                if (!Number.isSafeInteger(position) || position % 960) { fail(t("audio.invalidPosition")); return; }
                // Sample positions retain silent gaps; a new capture resets its clock.
                const now = context.currentTime;
                const gap = this.position === undefined || position <= this.position ? undefined : (position - this.position - 960) / 48000;
                this.position = position;
                if (gap === undefined) this.next = now + 0.12;
                else this.next += gap;
                if (this.next > now + 0.18) {
                    if (!gap) return;
                    this.next = now + 0.12;
                }
                if (this.next < now + 0.01) this.next = now + 0.12;
                const buffer = context.createBuffer(2, 960, 48000);
                for (let channel = 0; channel < 2; channel++) {
                    const samples = buffer.getChannelData(channel);
                    for (let i = 0; i < samples.length; i++) samples[i] = data.getInt16(8 + i * 4 + channel * 2, true) / 32768;
                }
                const source = context.createBufferSource(); source.buffer = buffer;
                source.connect(gain); this.sources.add(source);
                source.onended = () => { this.sources.delete(source); source.disconnect(); };
                source.start(this.next); this.next += buffer.duration;
            };
            socket.onclose = () => {
                if (this.socket !== socket) return;
                this.close();
            };
        } catch (error) { fail(error); }
    }

    close() {
        this.unlock?.abort(); this.unlock = undefined;
        const socket = this.socket; this.socket = undefined; socket?.close();
        for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
        this.sources.clear(); this.next = 0; this.position = undefined;
        this.gain?.disconnect(); this.gain = undefined;
        const context = this.context; this.context = undefined; void context?.close();
    }

}

export const audio = new UserAudio();
