class MicrophoneProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.packet = new DataView(new ArrayBuffer(1920));
        this.offset = 0;
        this.pending = 0;
        this.port.onmessage = () => { this.pending--; };
    }
    process(inputs) {
        const samples = inputs[0]?.[0];
        if (!samples) return true;
        for (const sample of samples) {
            // Bound queued messages to 200 ms when the page thread stalls.
            if (this.pending === 10) continue;
            this.packet.setInt16(this.offset, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true);
            this.offset += 2;
            if (this.offset === 1920) {
                this.port.postMessage({ pcm: this.packet.buffer, time: currentTime }, [this.packet.buffer]);
                this.packet = new DataView(new ArrayBuffer(1920));
                this.offset = 0;
                this.pending++;
            }
        }
        return true;
    }
}
registerProcessor('tuxee-microphone', MicrophoneProcessor);
