import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const fixtures = {
    css: { extensions: ['css'], source: '/* Layout */\n#app, .panel:hover {\n  color: #639bdc;\n  display: grid;\n  gap: 12px !important;\n  font-family: "Mono";\n}\n', tokens: [['comment', '/* Layout */'], ['type', 'app'], ['type', 'panel'], ['type', 'color'], ['number', '#639bdc'], ['keyword', 'grid'], ['number', '12'], ['keyword', 'px'], ['keyword', '!important'], ['string', 'Mono']] },
    go: { extensions: ['go'], source: '// Greeting\npackage main\nimport "fmt"\nfunc main() {\n  ready := true\n  count := 42\n  ratio := .5 + 1.25 + 1e3\n  fmt.Println("Hello", ready, count)\n  println(`raw string`)\n}\n', tokens: [['comment', '// Greeting'], ['keyword', 'package'], ['keyword', 'func'], ['string', 'fmt'], ['string', 'Hello'], ['string', 'raw string'], ['number', '42'], ['number', '.5'], ['number', '1.25'], ['number', '1e3'], ['keyword', 'true'], ['keyword', 'println']] },
    html: { extensions: ['html', 'htm'], source: '<!doctype html>\n<!-- Greeting -->\n<section class="panel" hidden>\n  <h1>Hello &amp; welcome</h1>\n  <input value=ready>\n  <style>.panel { color: red; }</style>\n  <script>const count = 42;</script>\n</section>\n', tokens: [['comment', '<!-- Greeting -->'], ['type', 'section'], ['type', 'class'], ['string', 'panel'], ['string', 'ready'], ['keyword', 'const'], ['number', '42']] },
    javascript: { extensions: ['js', 'mjs', 'cjs'], source: '// Greeting\nexport function greet(name) {\n  const count = 42;\n  const enabled = true;\n  const pattern = /hello/i;\n  return {message: `Hello ${name}`, count, enabled, pattern};\n}\nconsole.log(greet("Tuxee"));\n', tokens: [['comment', '// Greeting'], ['keyword', 'export'], ['function', 'greet'], ['number', '42'], ['number', 'true'], ['string', '/hello/i'], ['string', 'Hello'], ['type', 'message'], ['function', 'log'], ['string', 'Tuxee']] },
    json: { extensions: ['json', 'webmanifest'], source: '{\n  "name": "Tuxee",\n  "enabled": true,\n  "count": 42,\n  "missing": null,\n  "items": ["one", "two"]\n}\n', tokens: [['type', 'name'], ['string', 'Tuxee'], ['number', 'true'], ['number', '42'], ['number', 'null'], ['string', 'one']] },
    jsx: { extensions: ['jsx'], source: '// Component\nexport function Greeting({name}) {\n  const count = 42;\n  return <section className="panel">\n    <h1>Hello {name}</h1>\n    <button disabled={false}>{count}</button>\n  </section>;\n}\n', tokens: [['comment', '// Component'], ['keyword', 'export'], ['function', 'Greeting'], ['number', '42'], ['type', 'section'], ['type', 'className'], ['string', 'panel'], ['number', 'false']] },
    markdown: { extensions: ['md', 'markdown', 'mdown', 'mkd'], source: '# Heading\n\nOrdinary prose stays neutral.\n\n- List item with **bold** and *italic*\n1. Ordered item with ~~removed~~\n\n[Link](https://example.com) and `inline code`\n\n> A quotation\n\n```js\nconst count = 42;\n```\n', tokens: [['heading', 'Heading'], ['markup', 'List item'], ['strong', 'bold'], ['emphasis', 'italic'], ['strikethrough', 'removed'], ['link', 'Link'], ['monospace', 'inline code'], ['quote', 'quotation'], ['monospace', 'const count']] },
    python: { extensions: ['py', 'pyw', 'pyi'], source: '# Greeting\nclass Greeter:\n    async def greet(self, name: str):\n        count = 42\n        enabled = True\n        message = f"Hello {name}"\n        print(message)\n        return self.format(message) if enabled else None\n', tokens: [['comment', '# Greeting'], ['keyword', 'class'], ['type', 'Greeter'], ['keyword', 'async'], ['function', 'greet'], ['number', '42'], ['number', 'True'], ['string', 'Hello'], ['function', 'print'], ['function', 'format'], ['number', 'None']] },
    shell: { extensions: ['sh', 'bash', 'zsh', 'ksh'], source: '#!/bin/bash\n# Greeting\nset -e\nNAME="Tuxee"\nif [ -n "$NAME" ]; then\n  cd /tmp\n  echo "Hello $NAME"\n  exec app --config config.yaml\nfi\n', tokens: [['comment', '#!/bin/bash'], ['comment', '# Greeting'], ['keyword', 'set'], ['keyword', 'if'], ['type', '-e'], ['function', 'cd'], ['function', 'echo'], ['function', '$NAME'], ['function', 'exec'], ['type', '--config'], ['string', 'Hello']] },
    sql: { extensions: ['sql'], source: '-- Active accounts\nCREATE TABLE accounts (id INTEGER, name VARCHAR(64));\nSELECT name, COUNT(*) AS total\nFROM accounts\nWHERE id > 42 AND name = \'Tuxee\'\n  AND active = TRUE AND deleted_at IS NULL\nGROUP BY name;\n', tokens: [['comment', '-- Active accounts'], ['keyword', 'SELECT'], ['type', 'INTEGER'], ['type', 'VARCHAR'], ['number', '64'], ['number', '42'], ['string', 'Tuxee'], ['number', 'TRUE'], ['number', 'NULL']] },
    text: { extensions: ['txt', 'text', 'log'], source: 'Ordinary text and Unicode: Žluťoučký 🐧\nservices: true\nconst count = 42;\n<html> remains plain text.\n', tokens: [] },
    toml: { extensions: ['toml'], source: '# Application settings\ntitle = "Tuxee"\nenabled = true\ncount = 42\ncreated = 2026-10-29T12:00:00Z\n[server]\n"listen-port" = 80\npaths = ["/root", "/init"]\n', tokens: [['comment', '# Application settings'], ['type', 'title'], ['string', 'Tuxee'], ['keyword', 'true'], ['number', '42'], ['keyword', '2026-10-29T12:00:00Z'], ['keyword', '[server]'], ['type', 'listen-port'], ['string', '/root']] },
    tsx: { extensions: ['tsx'], source: '// Typed component\ntype Props = {name: string; count?: number};\nexport function Greeting({name, count = 42}: Props) {\n  return <section className="panel">\n    <h1>Hello {name}</h1>\n    <button disabled={false}>{count}</button>\n  </section>;\n}\n', tokens: [['comment', '// Typed component'], ['keyword', 'type'], ['type', 'Props'], ['type', 'string'], ['keyword', 'export'], ['function', 'Greeting'], ['number', '42'], ['type', 'section'], ['type', 'className'], ['string', 'panel'], ['number', 'false']] },
    typescript: { extensions: ['ts', 'mts', 'cts'], source: '// Typed greeting\ninterface User { name: string; active: boolean }\nexport function greet(user: User): string {\n  const count: number = 42;\n  return user.active ? `Hello ${user.name}` : "Goodbye";\n}\n', tokens: [['comment', '// Typed greeting'], ['keyword', 'interface'], ['type', 'User'], ['type', 'name'], ['type', 'string'], ['type', 'boolean'], ['function', 'greet'], ['number', '42'], ['string', 'Hello'], ['string', 'Goodbye']] },
    xml: { extensions: ['xml', 'xsd', 'xsl', 'xslt', 'svg', 'xhtml'], source: '<?xml version="1.0"?>\n<!-- Greeting -->\n<app:settings xmlns:app="urn:tuxee" enabled="true">\n  <app:name>Tuxee &amp; tools</app:name>\n  <app:script><![CDATA[echo "Hello"]]></app:script>\n</app:settings>\n', tokens: [['comment', '<!-- Greeting -->'], ['type', 'app:settings'], ['type', 'xmlns:app'], ['string', 'urn:tuxee'], ['type', 'enabled'], ['string', 'true']] },
    yaml: { extensions: ['yaml', 'yml'], source: '# Application settings\nservices:\n  tuxee:\n    image: agent0ai/tuxee:latest\n    ports: ["80:80", "443:443"]\n    enabled: true\n    retries: 3\ndefaults: &defaults {restart: unless-stopped}\ncopy: *defaults\nscript: |\n  echo hello\n', tokens: [['comment', '# Application settings'], ['type', 'services'], ['type', 'image'], ['string', 'agent0ai/tuxee:latest'], ['string', '80:80'], ['string', 'true'], ['string', '3'], ['function', '&defaults'], ['function', '*defaults'], ['markup', ':'], ['string', 'echo hello']] }
};

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return result.stdout.trim();
};
const output = 'test-results/editor-syntax';
await mkdir(output, { recursive: true });
assert.equal(process.getuid(), 0);
const home = await mkdtemp('/tmp/tuxee-syntax-user-'), state = await mkdtemp('/tmp/tuxee-syntax-state-'), user = `tuxee-syntax-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
await chown(home, Number(fields[2]), Number(fields[3]));
const password = randomBytes(24).toString('base64url'); run('chpasswd', [], `${user}:${password}\n`);
const files = [];
for (const [mode, fixture] of Object.entries(fixtures)) {
    for (const extension of fixture.extensions) for (const suffix of [extension, extension.toUpperCase()]) files.push({ name: `sample.${suffix}`, mode, source: fixture.source });
}
for (const name of ['.bashrc', '.profile', '.env', '.constructor']) files.push({ name, mode: 'shell', source: fixtures.shell.source });
for (const name of ['README', 'css', 'json', 'go', 'unknown.xyz', '.settings.unknown', 'trailing.', 'file.constructor', 'file.__proto__', 'styles.scss', 'data.jsonc', 'script.fish']) files.push({ name, mode: 'text', source: fixtures.text.source });
for (const file of files) {
    await writeFile(`${home}/${file.name}`, file.source);
    await chown(`${home}/${file.name}`, Number(fields[2]), Number(fields[3]));
}
const server = spawn(process.env.TUXEE_TEST_BINARY || './bin/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
const report = { modes: [], extensions: [], errors: [] }, failures = [];
let browser;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const { csrf } = await (await context.request.get(base + '/api/me')).json();
    assert.equal((await context.request.put(base + '/api/settings', { data: { theme: 'dark', current: 'syntax', workspaces: [{ id: 'syntax', name: 'Syntax', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: home, x: 0, y: 0, w: 4, h: 2 }] }] }, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } })).status(), 200);
    const page = await appPage(context); page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(base) && /^https?:/.test(request.url())) report.errors.push(`External request: ${request.url()}`); });
    await page.goto(base);
    const path = page.getByRole('textbox', { name: 'File or directory path', exact: true }), syntax = page.getByRole('combobox', { name: 'Syntax', exact: true }), content = page.locator('.cm-content');
    const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const open = async name => {
        const file = `${home}/${name}`;
        const read = page.waitForResponse(response => response.url().endsWith('/api/files') && response.request().postDataJSON()?.operation === 'read' && response.request().postDataJSON()?.path === file);
        await path.fill(file); await path.press('Enter'); await read;
        await page.locator('.inspector-body[aria-busy="false"] .cm-content').waitFor(); await paint();
    };
    for (const file of files) {
        await open(file.name);
        const actual = await syntax.inputValue();
        const highlighted = await content.locator('[class*="code-"]').count() > 0;
        report.extensions.push({ file: file.name, expected: file.mode, actual, highlighted });
        if (actual !== file.mode) failures.push(`${file.name}: expected ${file.mode}, got ${actual}`);
        if (highlighted !== (file.mode !== 'text')) failures.push(`${file.name}: incorrect automatic highlighting`);
        assert.equal((await content.locator('.cm-line').allTextContents()).join('\n'), file.source, file.name);
    }
    assert.deepEqual(await syntax.locator('option').evaluateAll(nodes => nodes.map(node => node.value)), Object.keys(fixtures).sort(), 'every selectable mode has a fixture');
    console.log(`Checked ${files.length} filename associations`);
    for (const theme of ['dark', 'light']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
        for (const [mode, fixture] of Object.entries(fixtures)) {
            const name = `sample.${fixture.extensions[0]}`;
            await open(name); await syntax.selectOption(mode); await paint();
            const tokens = await content.evaluate(node => {
                const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
                const luminance = color => rgb(color).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
                let parent = node, background;
                while (parent) { background = getComputedStyle(parent).backgroundColor; if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') break; parent = parent.parentElement; }
                const bg = luminance(background), foreground = getComputedStyle(node).color;
                return [...node.querySelectorAll('[class*="code-"]')].map(span => {
                    const style = getComputedStyle(span), fg = luminance(style.color);
                    return { text: span.textContent, classes: span.className, color: style.color, foreground, background, contrast: +((Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05)).toFixed(2) };
                });
            });
            const missing = fixture.tokens.filter(([kind, text]) => !tokens.some(token => token.classes.split(' ').includes('code-' + kind) && token.text.includes(text)));
            const faint = tokens.filter(token => token.text.trim() && token.contrast < 4.5);
            const neutral = tokens.filter(token => token.color === token.foreground && !/code-(strong|emphasis|strikethrough)/.test(token.classes));
            if (mode === 'text') assert.equal(tokens.length, 0, 'plain text has no syntax styles');
            if (mode === 'go' && tokens.some(token => token.text === '.' && token.classes.includes('code-number'))) failures.push('Go member-access dots must not be numbers');
            if (missing.length || faint.length || neutral.length) failures.push(`${theme}/${mode}: ${missing.length} missing, ${faint.length} low-contrast, ${neutral.length} neutral tokens`);
            report.modes.push({ mode, theme, missing, faint, neutral, tokens });
            await page.locator('.file-view').screenshot({ path: `${output}/${mode}-${theme}.png` });
            await syntax.selectOption('text'); await paint(); assert.equal(await content.locator('[class*="code-"]').count(), 0, 'plain-text switching removes styles');
            await syntax.selectOption(mode); await paint();
            assert.deepEqual(await content.locator('[class*="code-"]').evaluateAll(nodes => nodes.map(node => [node.textContent, node.className])), tokens.map(token => [token.text, token.classes]), `${mode} restores the same styles`);
            assert.equal((await content.locator('.cm-line').allTextContents()).join('\n'), fixture.source);
            assert.ok(await page.getByRole('button', { name: 'Save file', exact: true }).isDisabled());
            assert.equal(await readFile(`${home}/${name}`, 'utf8'), fixture.source);
            if (mode === 'markdown') assert.equal(await content.locator('.cm-line').filter({ hasText: 'Ordinary prose' }).locator('[class*="code-"]').count(), 0);
            console.log(`${theme}/${mode}: ${missing.length} missing, ${faint.length} low-contrast tokens`);
        }
    }
    await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
    await writeFile(`${output}/index.html`, '<!doctype html><meta charset="utf-8"><title>Tuxee syntax checks</title><style>body{font:16px system-ui;background:#ddd;margin:24px}section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0}img{width:100%}figcaption{padding:6px}</style>' + ['dark', 'light'].map(theme => `<h1>${theme}</h1><section>` + Object.keys(fixtures).map(mode => `<figure><figcaption>${mode}</figcaption><a href="${mode}-${theme}.png"><img src="${mode}-${theme}.png"></a></figure>`).join('') + '</section>').join(''));
    assert.deepEqual(report.errors, []);
    assert.deepEqual(failures, [], 'syntax/extension failures (details in test-results/editor-syntax/report.json)');
    console.log(`PASS all ${Object.keys(fixtures).length} modes in both themes, ${files.length} filenames, contrast, syntax switching and unchanged bytes`);
} finally {
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    run('userdel', [user]); await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
