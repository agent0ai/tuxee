// Shared by the browser and the embedded headless terminal engine.
export class MessageError extends Error {
    readonly text: { key: string; vars?: Record<string, unknown> };
    constructor(key: string, vars?: Record<string, unknown>) {
        super(key);
        this.text = { key, vars };
    }
}
