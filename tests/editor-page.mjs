import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('.test-state', { recursive: true });
await build({
    stdin: { contents: "export * from './web/editor-page'; export { EditorState } from './web/vendor/code-editor/library.js';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: '.test-state/editor-page.mjs'
});
const { EditorState, PageDraft, languageFor, pageLimitError } = await import('../.test-state/editor-page.mjs');
for (const [path, mode] of [
    ['/root/.bashrc', 'shell'], ['/root/.profile', 'shell'], ['/root/.env', 'shell'],
    ['/root/.config.json', 'json'], ['/root/.thing.unknown', 'text'],
    ['/root/.config/README', 'text'], ['/root/README', 'text'], ['/root/file.md', 'markdown'],
    ['/root/config.xml', 'xml'], ['/root/config.XML', 'xml']
]) assert.equal(languageFor(path), mode, path);

for (const [content, valid] of [
    ['', true], ['x'.repeat(1 << 20), true], ['x'.repeat((1 << 20) + 1), false],
    ['🙂'.repeat((1 << 20) / 4), true], ['🙂'.repeat((1 << 20) / 4 + 1), false],
    ['\r\n'.repeat(9999), true], ['\n'.repeat(10000), false],
    ['\n'.repeat(9998) + 'x'.repeat(2000), true], ['\n'.repeat(9998) + 'x'.repeat(2001), false]
]) assert.equal(!pageLimitError(content), valid);

const original = 'one\r\ntwo\nthree\rfour🙂\r\n';
let state = EditorState.create({ doc: original }), draft = new PageDraft(original, state);
const change = spec => {
    const transaction = state.update({ changes: spec });
    draft.changes = draft.changes.compose(transaction.changes);
    state = transaction.state;
    return transaction;
};
assert.equal(draft.content(), original);
const edit = change({ from: 4, to: 7, insert: 'TWO' });
assert.equal(draft.content(), 'one\r\nTWO\nthree\rfour🙂\r\n');
assert.ok(draft.dirty(state.doc));
change(edit.changes.invert(edit.startState.doc));
assert.equal(draft.content(), original, 'undo preserves mixed original line endings');
assert.equal(draft.dirty(state.doc), false);
change({ from: state.doc.length, insert: 'new\nline' });
assert.equal(draft.content(), original + 'new\r\nline');
const saved = draft.content();
draft = new PageDraft(saved, state);
change({ from: 2, to: 5, insert: '界\n' });
assert.equal(draft.content(), 'on界\r\nwo\nthree\rfour🙂\r\nnew\r\nline', 'replace across CRLF without touching later line endings');
assert.equal(draft.dirty(state.doc), true);

console.log('PASS bounded editor pages, hidden-file syntax and exact line endings');
