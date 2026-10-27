import { t } from './i18n';
import { Decoration, EditorView, StateField } from './vendor/code-editor/library.js';
// WidgetType is exposed by this matched vendor chunk, not its library entrypoint.
import { u as WidgetType } from './vendor/code-editor/chunk-36OFQ4TD.js';

export const MAX_PAGE_BYTES = 1 << 20, MAX_PAGE_ROWS = 10000, WRAP_COLUMNS = 1000;
export type TextPage = { offset: number; end: number; total: number; lineBreaks: number; hash: string };

export function languageFor(path: string): string {
    const name = path.split('/').pop()!, extension = name.split('.').pop()!.toLowerCase();
    return ({ js:'javascript', mjs:'javascript', cjs:'javascript', ts:'typescript', jsx:'jsx', tsx:'tsx', json:'json', html:'html', htm:'html', xml:'xml', css:'css', py:'python', sql:'sql', md:'markdown', yaml:'yaml', yml:'yaml', go:'go', sh:'shell', bash:'shell', toml:'toml' } as Record<string,string>)[extension]
        || (name.startsWith('.') && !name.slice(1).includes('.') ? 'shell' : 'text');
}

export function pageLimitError(content: string): string | undefined {
    if (new TextEncoder().encode(content).length > MAX_PAGE_BYTES) return t("editor.pageByteLimit", { maxMiB: MAX_PAGE_BYTES / (1 << 20) });
    let rows = 1, columns = 0, previous = '';
    for (const char of content) {
        if (char === '\r' || char === '\n') {
            if (char !== '\n' || previous !== '\r') rows++;
            columns = 0;
        } else {
            if (columns === WRAP_COLUMNS) { rows++; columns = 0; }
            columns++;
        }
        if (rows > MAX_PAGE_ROWS) return t("editor.pageRowLimit", { max: MAX_PAGE_ROWS });
        previous = char;
    }
}

// Map edits onto the original bytes' text representation, preserving untouched mixed line endings.
export class PageDraft {
    changes;
    private base;
    private starts = [0];
    private separator: string;
    constructor(private original: string, state) {
        this.base = state.doc;
        this.changes = state.changes([]);
        for (const match of original.matchAll(/\r\n?|\n/g)) this.starts.push(match.index! + match[0].length);
        this.separator = original.match(/\r\n?|\n/)?.[0] || '\n';
    }
    content(changes = this.changes): string {
        const rawPosition = (position: number) => {
            const line = this.base.lineAt(position);
            return this.starts[line.number - 1] + position - line.from;
        };
        const parts: string[] = [];
        let end = 0;
        changes.iterChanges((from, to, _from, _to, inserted) => {
            if (inserted.eq(this.base.slice(from, to))) return;
            const start = rawPosition(from);
            parts.push(this.original.slice(end, start), inserted.toString().replace(/\n/g, this.separator));
            end = rawPosition(to);
        });
        parts.push(this.original.slice(end));
        return parts.join('');
    }
    dirty(doc): boolean { return !doc.eq(this.base); }
}

class SoftBreak extends WidgetType {
    eq() { return true; }
    toDOM() { const br = document.createElement('br'); br.className = 'editor-soft-break'; return br; }
    get lineBreaks() { return 1; }
}
const softBreak = new SoftBreak();
function wrappedLines(doc) {
    const ranges = [];
    for (let number = 1; number <= doc.lines; number++) {
        const line = doc.line(number);
        let columns = 0, position = line.from;
        for (const char of line.text) {
            if (columns === WRAP_COLUMNS) {
                ranges.push(Decoration.widget({ widget: softBreak, side: 1 }).range(position));
                columns = 0;
            }
            position += char.length;
            columns++;
        }
    }
    return Decoration.set(ranges);
}
export const pageWrapping = StateField.define({
    create: state => wrappedLines(state.doc),
    update: (value, transaction) => transaction.docChanged ? wrappedLines(transaction.newDoc) : value,
    provide: field => EditorView.decorations.from(field)
});
