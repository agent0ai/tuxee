import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const requiredLanguages = ['ar', 'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fil', 'fr', 'he', 'hi', 'hr', 'hu', 'id', 'is', 'it', 'ja', 'ko', 'lt', 'lv', 'ms', 'nb', 'nl', 'pl', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sk', 'sl', 'sr-Latn', 'sv', 'th', 'tr', 'uk', 'vi', 'zh-CN', 'zh-TW'];
const cssTexts = source => [...source.matchAll(/\bcontent:\s*(['"])([^'"\n]*[\p{L}][^'"\n]*)\1/gu)].map(match => match[2]);
const variable = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const variables = text => [...new Set([...text.matchAll(variable)].map(match => match[1]))].sort().join(',');

export function parseCatalog(source) {
    const catalog = JSON.parse(source);
    // JSON.parse accepts duplicate keys; translation files must not silently overwrite them.
    const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) || [], stack = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === '{') stack.push(new Set());
        else if (tokens[i] === '}') stack.pop();
        else if (tokens[i].startsWith('"') && tokens[i + 1] === ':') {
            const key = JSON.parse(tokens[i]);
            if (stack.at(-1).has(key)) throw Error(`duplicate key: ${key}`);
            stack.at(-1).add(key);
        }
    }
    if (typeof catalog.name !== 'string' || !catalog.name.trim() || !catalog.texts || typeof catalog.texts !== 'object' || Array.isArray(catalog.texts)) throw Error('expected name and texts');
    if (Object.keys(catalog).some(key => !['name', 'texts'].includes(key))) throw Error('unexpected catalog field');
    for (const [key, value] of Object.entries(catalog.texts)) {
        if (!/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/.test(key) || typeof value !== 'string') throw Error(`invalid message: ${key}`);
    }
    return catalog;
}

export function compare(catalogs) {
    const errors = [];
    for (const code of requiredLanguages) if (!catalogs[code]) errors.push(`missing language: ${code}`);
    if (!catalogs.en) return errors;
    for (const [code, catalog] of Object.entries(catalogs)) {
        for (const [key, value] of Object.entries(catalogs.en.texts)) {
            if (!Object.hasOwn(catalog.texts, key)) errors.push(`${code}: missing ${key}`);
            else if (variables(value) !== variables(catalog.texts[key])) errors.push(`${code}: variables differ for ${key}`);
        }
        for (const key of Object.keys(catalog.texts)) if (!Object.hasOwn(catalogs.en.texts, key)) errors.push(`${code}: extra ${key}`);
    }
    return errors;
}

export function lengthWarnings(catalogs) {
    const segments = new Intl.Segmenter('en', { granularity: 'grapheme' });
    // Variable names have no bearing on rendered length; give each substitution equal weight.
    const length = text => [...segments.segment(text.replace(variable, '◊').normalize('NFC'))].length;
    const warnings = [];
    for (const [key, english] of Object.entries(catalogs.en?.texts || {})) {
        const sourceLength = length(english);
        if (!sourceLength) continue;
        for (const [language, catalog] of Object.entries(catalogs)) {
            const translated = catalog.texts[key];
            if (language === 'en' || typeof translated !== 'string') continue;
            const translatedLength = length(translated), ratio = translatedLength / sourceLength;
            if (ratio < (sourceLength <= 30 ? 1.75 : 2) || translatedLength - sourceLength < (sourceLength <= 30 ? 8 : 20)) continue;
            warnings.push({ language, key, english, translated, sourceLength, translatedLength, increasePercent: Math.round((ratio - 1) * 100) });
        }
    }
    return warnings.sort((a, b) => b.increasePercent - a.increasePercent || a.language.localeCompare(b.language) || a.key.localeCompare(b.key));
}

async function sourceFiles(directory, suffixes) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const files = [];
    for (const entry of entries) {
        if (['vendor', 'dist', 'locales', 'node_modules'].includes(entry.name)) continue;
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) files.push(...await sourceFiles(path, suffixes));
        else if (suffixes.some(suffix => path.endsWith(suffix)) && !path.endsWith('_test.go')) files.push(path);
    }
    return files;
}

export async function check() {
    const catalogs = {}, errors = [];
    for (const name of await readdir('internal/i18n/locales')) {
        if (!name.endsWith('.json')) continue;
        const code = name.slice(0, -5);
        try {
            if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(code)) throw Error('invalid language code');
            Intl.getCanonicalLocales(code);
            catalogs[code] = parseCatalog(await readFile(`internal/i18n/locales/${name}`, 'utf8')); }
        catch (error) { errors.push(`${name}: ${error.message}`); }
    }
    errors.push(...compare(catalogs));
    const texts = catalogs.en?.texts || {};
    for (const path of [...await sourceFiles('web', ['.ts', '.js', '.css']), ...await sourceFiles('internal', ['.go'])]) {
        const source = await readFile(path, 'utf8');
        const references = path.endsWith('.go') ? /(?:i18n\.(?:New|Wrap)\(|\bKey:)\s*"([^"]+)"/g : /(?:\bt\(|new MessageError\(|\bkey:)\s*['"]([^'"]+)['"]/g;
        for (const match of source.matchAll(references)) {
            // Only message-shaped worker keys; keyboard bindings also have a key property.
            if (!match[1].includes('.')) continue;
            if (!Object.hasOwn(texts, match[1])) errors.push(`${path}: unknown key ${match[1]}`);
        }
        if (path.endsWith('.css')) for (const text of cssTexts(source)) errors.push(`${path}: hardcoded CSS text ${text}`);
        if (path.startsWith('web/') && path !== 'web/i18n.ts') {
            for (const match of source.matchAll(/(?:\bbutton\(|\b(?:title|textContent|placeholder)\s*=|setAttribute\(['"]aria-(?:label|description)['"],\s*)\s*['"]([A-Za-z][^'"\n]*)['"]/g)) errors.push(`${path}: hardcoded UI text ${match[1]}`);
            if (/\[(?:title|aria-label)=/.test(source) || /\.(?:title|textContent)\s*===\s*['"]/.test(source)) errors.push(`${path}: display text used as a selector or identity`);
        }
    }
    if (errors.length) throw Error(`Translation check failed:\n${errors.join('\n')}`);
    const warnings = lengthWarnings(catalogs), report = 'test-results/i18n-length-report.json';
    await mkdir('test-results', { recursive: true });
    await writeFile(report, JSON.stringify(warnings, null, 2) + '\n');
    console.log(`Translations: ${Object.keys(texts).length} keys, ${Object.keys(catalogs).join(', ')} complete.`);
    if (warnings.length) {
        console.warn(`Translation length: ${warnings.length} advisory warnings; full report: ${report}. Largest increases:`);
        for (const warning of warnings.slice(0, 10)) console.warn(`  ${warning.language} ${warning.key}: +${warning.increasePercent}% (${warning.sourceLength} → ${warning.translatedLength}) ${JSON.stringify(warning.english)} → ${JSON.stringify(warning.translated)}`);
    }
}

function selfTest() {
    assert.deepEqual(cssTexts('.hint { content: "(Ctrl to copy)"; }'), ['(Ctrl to copy)']);
    assert.deepEqual(cssTexts('.hint { content: attr(data-drop-hint); } .icon { content: ""; }'), []);
    const en = parseCatalog('{"name":"English","texts":{"test.message":"Hello {name}"}}');
    assert.throws(() => parseCatalog('{"name":"English","texts":{"test.message":"a","test.message":"b"}}'), /duplicate/);
    assert.throws(() => parseCatalog('{"name":"English","texts":{},"messages":{}}'), /unexpected catalog field/);
    const complete = Object.fromEntries(requiredLanguages.map(code => [code, en]));
    assert.deepEqual(compare({ ...complete, cs: { name: 'Čeština', texts: { 'test.message': 'Ahoj {name}' } } }), []);
    for (const code of requiredLanguages) {
        const missing = { ...complete }; delete missing[code];
        assert.ok(compare(missing).includes(`missing language: ${code}`));
    }
    assert.ok(compare({ en }).some(error => error.includes('missing language: cs')));
    assert.ok(compare({ en, cs: { name: 'Čeština', texts: {} } }).some(error => error.includes('missing test.message')));
    assert.ok(compare({ en, cs: { name: 'Čeština', texts: { 'test.message': 'Ahoj {other}' } } }).some(error => error.includes('variables differ')));
    assert.ok(compare({ en, cs: { name: 'Čeština', texts: { ...en.texts, 'test.extra': 'Navíc' } } }).some(error => error.includes('extra')));
    const lengths = translated => lengthWarnings({ en: { texts: { 'test.label': 'Workspace {longVariableName}' } }, cs: { texts: { 'test.label': translated } } });
    assert.equal(lengths('Plocha {longVariableName}').length, 0, 'shorter translations never warn');
    assert.equal(lengths('Pracovní plocha {longVariableName}').length, 0, 'small expansions do not warn');
    assert.equal(lengths('Velmi dlouhá pracovní plocha {longVariableName}')[0].sourceLength, 11);
    assert.equal(lengths('Velmi dlouhá pracovní plocha {longVariableName}')[0].increasePercent, 173);
    assert.equal(lengths('Velmi dlouhá pracovní plocha {longVariableName}'.normalize('NFD'))[0].translatedLength, 30, 'combining marks do not inflate lengths');
    assert.deepEqual(lengthWarnings({ cs: en }), []);
    assert.deepEqual(lengthWarnings({ en: { texts: { 'test.empty': '' } }, cs: { texts: { 'test.empty': 'Dlouhý text' } } }), []);
    assert.deepEqual(lengthWarnings({ en: { texts: { 'test.long': 'a'.repeat(40) } }, cs: { texts: { 'test.long': 'b'.repeat(79) } } }), []);
    assert.equal(lengthWarnings({ en: { texts: { 'test.long': 'a'.repeat(40) } }, cs: { texts: { 'test.long': 'b'.repeat(80) } } })[0].increasePercent, 100);
    console.log('Translation checker self-test passed.');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--self-test')) selfTest();
    else await check();
}
