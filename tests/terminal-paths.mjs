import assert from 'node:assert/strict';
import { build } from 'esbuild';
import headless from '@xterm/headless';
const { Terminal } = headless;
const compiled = await build({ entryPoints: ['web/terminal/paths.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { terminalLinks, terminalLink, terminalPath } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
assert.deepEqual(terminalPath('"~/spaced name":12:3'), { path: '~/spaced name', line: 12, column: 3 });
assert.deepEqual(terminalPath('/tmp/selected name'), { path: '/tmp/selected name', line: undefined, column: undefined });
for (const text of ['/', '10.2', 'MB/s', 'https://example.com/a', '/tmp/a\n/tmp/b']) assert.equal(terminalPath(text), undefined);
for (const text of ['http://localhost:8080/a?x=1&y=2#part', 'https://example.com/a_(b)', 'https://[::1]:443/a', 'HTTPS://EXAMPLE.COM'])
    assert.deepEqual(terminalLink(text), { url: new URL(text).href });
assert.deepEqual(terminalLink('"https://example.com/a"'), { url: 'https://example.com/a' });
for (const host of ['', 'localhost', 'LOCALHOST', 'server', 'SERVER'])
    assert.deepEqual(terminalLink(`file://${host}/tmp/a%20b.cc:12:3`, 'server'), { path: '/tmp/a b.cc', line: 12, column: 3 });
assert.deepEqual(terminalLink('"file:///tmp/a b.cc":2'), { path: '/tmp/a b.cc', line: 2, column: undefined });
assert.deepEqual(terminalLink('file:///tmp/%E6%96%87%23%3F%253A%3A42'), { path: '/tmp/文#?%3A:42', line: undefined, column: undefined }, 'decode once, after parsing line suffixes');
for (const text of ['file://other/tmp/a', 'file://user@server/tmp/a', 'file://server:80/tmp/a', 'file:///tmp/%xx', 'file:///tmp/%00a', 'file:///tmp/%0Aa', 'file:///tmp/a?query', 'file:///tmp/a#fragment', 'file:///tmp\\a',
    'http://', 'https:///path', 'http://a:99999/', 'http://a\n/b', 'http://a\\b', 'https://a b/', 'ftp://example.com/a', 'mailto:a@b.com', 'javascript:alert(1)', 'data:text/html,hi', 'vscode://file/tmp/a', 'www.example.com', 'example.com'])
    assert.equal(terminalLink(text, 'server'), undefined, text);
const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
const write = text => new Promise(resolve => term.write(text, resolve));
await write('"/tmp/a b.txt":12:3 ./relative.go:8 https://example.com/a\r\n');
const first = terminalLinks(term, 1);
assert.deepEqual(first.filter(value => 'path' in value).map(({ path, line, column }) => ({ path, line, column })), [
    { path: '/tmp/a b.txt', line: 12, column: 3 }, { path: './relative.go', line: 8, column: undefined },
]);
assert.equal(first[2].url, 'https://example.com/a');
assert.equal(first[0].range.end.x, 19, 'line and column are clickable');
await write('👋 /tmp/long-folder/this-is-a-long-name.txt\r\n');
const wrapped = terminalLinks(term, 3).find(value => value.path === '/tmp/long-folder/this-is-a-long-name.txt');
assert.ok(wrapped);
assert.equal(wrapped.range.start.y, 3);
assert.equal(wrapped.range.end.y, 4);
term.reset();
await write('("./my folder") (/tmp/file) (https://example.com/a)');
assert.deepEqual(terminalLinks(term, 1).map(value => value.path || value.url), ['./my folder', '/tmp/file', 'https://example.com/a']);
term.reset(); term.resize(120, 10);
await write("Fetched 10.2 MB in 1s (10.4 MB/s) Run 'apt list --upgradable' trixie/main / /:12\r\n");
assert.deepEqual(terminalLinks(term, 1), []);
await write('~/folder ../other ./file /etc/test "./my folder":3:2');
assert.deepEqual(terminalLinks(term, 2).map(value => value.path), ['~/folder', '../other', './file', '/etc/test', './my folder']);
term.reset();
await write('(https://example.com/a_(b)). [http://[::1]:8080] "https://example.com/end." file:///tmp/a%20b.cc:4:2');
assert.deepEqual(terminalLinks(term, 1).map(value => value.url || value.path), ['https://example.com/a_(b)', 'http://[::1]:8080/', 'https://example.com/end.', '/tmp/a b.cc']);
term.reset(); term.resize(40, 10);
await write('👋 https://example.com/long-folder/this-is-a-long-name?q=1#part');
const url = terminalLinks(term, 2)[0];
assert.equal(url.url, 'https://example.com/long-folder/this-is-a-long-name?q=1#part');
assert.equal(url.range.start.y, 1); assert.equal(url.range.end.y, 2);
term.dispose();
console.log('PASS terminal links: HTTP(S), local file URIs, validation, prefixes, quoted names, line/column and wrapped cells');
