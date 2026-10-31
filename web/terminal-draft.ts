import { api } from './ui';

type Draft = { text: string; open: boolean };
type SavedDraft = Draft & { revision: string };

export class TerminalInputDraft {
    private terminal = '';
    private saved?: SavedDraft;
    private touched = false;
    private timer?: ReturnType<typeof setTimeout>;
    private saving?: Promise<boolean>;
    get ready() { return !!this.saved; }
    constructor(private read: () => Draft, private restore: (draft: Draft) => void,
        private notice: (error: unknown) => void, private signal: AbortSignal) {
        window.addEventListener('beforeunload', event => {
            if (this.dirty) { void this.flush(); event.preventDefault(); }
        }, { signal });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) void this.flush();
        }, { signal });
        signal.addEventListener('abort', () => clearTimeout(this.timer), { once: true });
    }
    private get dirty() {
        const draft = this.read();
        return draft.text !== (this.saved?.text ?? '') || draft.open !== (this.saved?.open ?? false);
    }
    changed() {
        this.touched = true;
        this.timer ??= setTimeout(() => { void this.flush(); }, 300);
    }
    async load(terminal: string) {
        if (this.terminal === terminal && this.saved) return;
        await this.saving;
        const preserve = !!this.saved || this.touched;
        this.terminal = terminal; this.saved = undefined;
        try {
            const saved = await api<SavedDraft>(`/terminals/${terminal}/input-draft`, 'GET', undefined, this.signal);
            if (this.signal.aborted) return;
            this.saved = saved;
            if (!preserve) this.restore(saved);
            else await this.flush();
        } catch (error) { if (!this.signal.aborted) this.notice(error); }
    }
    flush(): Promise<boolean> {
        clearTimeout(this.timer); this.timer = undefined;
        if (this.saving) return this.saving;
        if (!this.dirty) return Promise.resolve(true);
        if (!this.saved || this.signal.aborted) return Promise.resolve(false);
        this.saving = (async () => {
            try {
                while (this.dirty && !this.signal.aborted) {
                    const draft = { ...this.read(), revision: this.saved!.revision };
                    this.saved = await api<SavedDraft>(`/terminals/${this.terminal}/input-draft`, 'PUT', draft, this.signal);
                }
                return !this.dirty;
            } catch (error) {
                if (!this.signal.aborted) this.notice(error);
                return false;
            }
        })().finally(() => { this.saving = undefined; });
        return this.saving;
    }
}
