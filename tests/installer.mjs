import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'tuxee-installer-test-'));
const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
const tools = join(root, 'tools');
await mkdir(tools);
const binary = '#!/bin/sh\ncase "$1" in version) echo "Tuxee 1.2.3";; __install) printf installed > "$INSTALL_RESULT";; *) exit 1;; esac\n';
await writeFile(join(root, 'binary'), binary);
const sum = createHash('sha256').update(binary).digest('hex');
await writeFile(join(tools, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
await writeFile(join(tools, 'uname'), '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo "${TEST_ARCH:-x86_64}"; fi\n', { mode: 0o755 });
await writeFile(join(tools, 'curl'), `#!${process.execPath}
const fs=require('fs'), args=process.argv.slice(2), url=args.at(-1), target=args[args.indexOf('-o')+1], root=process.env.FIXTURES;
if(url==='https://github.com/agent0ai/tuxee/releases/latest'){process.stdout.write('https://github.com/agent0ai/tuxee/releases/tag/v1.2.3');process.exit(0);}
if(!url.startsWith('https://github.com/agent0ai/tuxee/releases/download/v1.2.3/'))process.exit(22);
if(process.env.FAIL_DOWNLOAD==='yes')process.exit(22);
fs.copyFileSync(root+(url.endsWith('checksums.txt')?'/checksums.txt':'/binary'),target);
`, { mode: 0o755 });
async function run(args = [], extra = {}, good = true, previous = null) {
    const stage = join(root, 'temp'), result = join(root, 'installed');
    await mkdir(stage, { recursive: true });
    if (previous === null) await rm(result, { force: true });
    else await writeFile(result, previous);
    const proc = spawnSync('/bin/sh', ['-s', '--', ...args], {
        input: script, encoding: 'utf8',
        env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, TMPDIR: stage, FIXTURES: root, INSTALL_RESULT: result, ...extra },
    });
    assert.equal(proc.status === 0, good, proc.stdout + proc.stderr);
    if (good) assert.equal(await readFile(result, 'utf8'), 'installed');
    else if (previous !== null) assert.equal(await readFile(result, 'utf8'), previous);
    else await assert.rejects(readFile(result), { code: 'ENOENT' });
    assert.deepEqual(await readdir(stage), [], 'installer left partial downloads');
}
try {
    await writeFile(join(root, 'checksums.txt'), `${sum}  tuxee-linux-amd64\n${sum}  tuxee-linux-arm64\n`);
    await run(); await run(['v1.2.3']); await run(['1.2.3'], { TEST_ARCH: 'aarch64' });
    // Old installations need neither update nor __install: only the download runs.
    await writeFile(join(tools, 'tuxee'), '#!/bin/sh\nprintf called > "$FIXTURES/legacy-called"\nexit 99\n', { mode: 0o755 });
    await run([], {}, true, 'old installation');
    await run(['v1.2.3'], {}, true, 'installed');
    await assert.rejects(readFile(join(root, 'legacy-called')), { code: 'ENOENT' });
    await run(['v1.2.3'], { FAIL_DOWNLOAD: 'yes' }, false, 'old installation');
    await run(['v1.2.3'], { TEST_ARCH: 'armv7l' }, false);
    await run(['v1.2.3;echo bad'], {}, false);
    await writeFile(join(root, 'checksums.txt'), `${'0'.repeat(64)}  tuxee-linux-amd64\n`);
    await run([], {}, false, 'old installation');
    await writeFile(join(root, 'checksums.txt'), '');
    await run([], {}, false);
    // A truncated piped script must not start installation.
    const truncated = spawnSync('/bin/sh', { input: script.slice(0, script.indexOf('main "$@"')), encoding: 'utf8', env: { ...process.env, PATH: `${tools}:${process.env.PATH}` } });
    assert.equal(truncated.status, 0);
    console.log('PASS installer: fresh install, legacy upgrade, repeat install, latest/pinned versions, both architectures, checksum/download failures, cleanup and truncated input');
} finally { await rm(root, { recursive: true, force: true }); }
