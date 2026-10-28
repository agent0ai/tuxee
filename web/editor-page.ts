import { t } from './i18n';

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
