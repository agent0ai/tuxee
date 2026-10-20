import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const initRunner = fileURLToPath(new URL('../docker/docker-init.sh', import.meta.url));
const entrypointSource = fileURLToPath(new URL('../docker/entrypoint.sh', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'tuxee-init-test-'));
const entrypoint = join(directory, 'entrypoint.sh'), passwordMarker = join(directory, '.root-password-initialized');
const init = join(directory, 'init'), log = join(directory, 'scripts.log'), release = join(directory, 'release');
const env = { ...process.env, INIT_TEST_LOG: log, INIT_TEST_VALUE: 'original', INIT_TEST_DIRECTORY: init, INIT_TEST_RELEASE: release };
const run = () => spawnSync('bash', [initRunner, init], { env, encoding: 'utf8', timeout: 15000 });
const lines = async path => (await readFile(path, 'utf8')).trim().split('\n');
try {
    await copyFile(entrypointSource, entrypoint);
    await copyFile(initRunner, join(directory, 'docker-init.sh'));
    await mkdir(init);
    await writeFile(join(init, '30-last.sh'), 'until [[ -f "$INIT_TEST_RELEASE.started" ]]; do sleep 0.05; done\nprintf "last:%s\\n" "$INIT_TEST_VALUE" >> "$INIT_TEST_LOG"\ntouch "$INIT_TEST_RELEASE"\n');
    await writeFile(join(init, '10-first script.sh'), '[[ "$PWD" == "$INIT_TEST_DIRECTORY" ]] || exit 99\nexport INIT_TEST_VALUE=changed\ntouch "$INIT_TEST_RELEASE.started"\nuntil [[ -f "$INIT_TEST_RELEASE" ]]; do sleep 0.05; done\nprintf "first\\n" >> "$INIT_TEST_LOG"\n', { mode: 0o600 });
    await writeFile(join(init, '20-failure.sh'), 'printf "failed\\n" >> "$INIT_TEST_LOG"\nexit 7\n');
    await writeFile(join(init, '21-crash.sh'), 'printf "crashed\\n" >> "$INIT_TEST_LOG"\nkill -KILL "$$"\n');
    await writeFile(join(init, '25-Z.sh'), 'printf "upper\\n" >> "$INIT_TEST_LOG"\n');
    await writeFile(join(init, '25-a.sh'), 'printf "lower\\n" >> "$INIT_TEST_LOG"\n');
    await writeFile(join(init, 'README.md'), 'exit 99\n', { mode: 0o755 });
    await writeFile(join(init, '.hidden.sh'), 'exit 99\n');
    await mkdir(join(init, '05-directory.sh'));
    await writeFile(join(init, '05-directory.sh', 'nested.sh'), 'exit 99\n');
    for (let i = 0; i < 2; i++) {
        await rm(release, { force: true });
        await rm(`${release}.started`, { force: true });
        const result = run();
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /20-failure\.sh failed \(exit 7\); other scripts continue/);
        assert.match(result.stderr, /21-crash\.sh failed \(exit 137\); other scripts continue/);
        assert.equal((result.stdout.match(/Tuxee init: running/g) || []).length, 6);
    }
    const expected = ['first', 'failed', 'crashed', 'upper', 'lower', 'last:original'];
    assert.deepEqual((await lines(log)).sort(), [...expected, ...expected].sort());
    console.log('PASS parallel hooks, spaces, non-executable scripts, ignored files, failure/crash isolation, restart replay and environment isolation');
    await rm(init, { recursive: true }); await mkdir(init);
    assert.equal(run().status, 0, 'an empty init directory must finish normally');
    console.log('PASS empty init directory');

    if (process.getuid?.() === 0) {
        // Redirect the real chpasswd to disposable account files; never touch host accounts.
        const accountRoot = join(directory, 'accounts'), bin = join(directory, 'bin'), started = join(directory, 'started');
        await mkdir(join(accountRoot, 'etc'), { recursive: true }); await mkdir(bin);
        await writeFile(join(accountRoot, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/bash\n');
        const shadow = join(accountRoot, 'etc/shadow'), initialShadow = 'root:!:19000:0:99999:7:::\n';
        await writeFile(shadow, initialShadow, { mode: 0o600 });
        await writeFile(join(bin, 'chpasswd'), `#!/bin/bash
set -e
[[ "\${INIT_TEST_FAIL:-}" != 1 ]] || exit 1
IFS= read -r input
[[ "$input" == "root:$INIT_TEST_PASSWORD" ]] || exit 1
printf '%s\\n' "$input" | /usr/sbin/chpasswd --root "$INIT_TEST_ACCOUNT_ROOT" --crypt-method SHA512
`, { mode: 0o700 });
        await writeFile(join(init, 'password-env.sh'), '[[ ! -v ROOT_PASSWORD ]] && touch "$INIT_TEST_STARTED.hook"\n');
        const initialize = password => {
            const startupEnv = { ...env, PATH: `${bin}:${process.env.PATH}`, INIT_TEST_ACCOUNT_ROOT: accountRoot,
                INIT_TEST_PASSWORD: password ?? 'toor', INIT_TEST_STARTED: started };
            if (password === undefined) delete startupEnv.ROOT_PASSWORD; else startupEnv.ROOT_PASSWORD = password;
            return spawnSync('bash', [entrypoint, init, 'bash', '-c',
                '[[ ! -v ROOT_PASSWORD ]] || exit 83; until [[ -f "$INIT_TEST_STARTED.hook" ]]; do sleep 0.01; done; touch "$INIT_TEST_STARTED"; kill -TERM "$PPID"'],
                { env: startupEnv, encoding: 'utf8', timeout: 3000 });
        };
        for (const password of [undefined, 'spaces : $ \'" \\\\ punctuation']) {
            await rm(passwordMarker, { force: true }); await rm(started, { force: true }); await rm(`${started}.hook`, { force: true });
            assert.equal(initialize(password).status, 0, 'first startup must initialize the account and start both jobs');
            await readFile(started); await readFile(passwordMarker);
            const initialized = await readFile(shadow, 'utf8'); assert.match(initialized, /^root:\$6\$/);
            assert.equal(initialize('different password').status, 0);
            assert.equal(await readFile(shadow, 'utf8'), initialized, 'container restarts must not reset the password');
            await writeFile(shadow, initialShadow);
            assert.equal(initialize('ignored').status, 0);
            assert.equal(await readFile(shadow, 'utf8'), initialShadow, 'manual account changes must survive restarts');
        }
        for (const password of ['', 'line\nbreak', 'line\rbreak']) {
            await rm(passwordMarker, { force: true }); await rm(started, { force: true });
            const result = initialize(password);
            assert.equal(result.status, 1); assert.match(result.stderr, /ROOT_PASSWORD must be nonempty and contain no line breaks/);
            await assert.rejects(readFile(passwordMarker), { code: 'ENOENT' }); await assert.rejects(readFile(started), { code: 'ENOENT' });
            assert.equal(await readFile(shadow, 'utf8'), initialShadow);
        }
        env.INIT_TEST_FAIL = '1';
        assert.equal(initialize('failed update').status, 1); await assert.rejects(readFile(passwordMarker), { code: 'ENOENT' });
        delete env.INIT_TEST_FAIL;
        assert.equal(initialize('retry update').status, 0, 'failed initialization must remain retryable');
        await rm(join(init, 'password-env.sh'));
        console.log('PASS first-run/default root password, exact special characters, restart/manual-change preservation, secret environment cleanup, invalid input and failed-update retry using isolated account files');
    } else console.log('SKIP isolated root password initialization: requires root for chpasswd --root');
    // Remaining lifecycle checks must never initialize the host account.
    await writeFile(passwordMarker, '');

    if (spawnSync('sh', ['-c', 'command -v tini'], { encoding: 'utf8' }).status !== 0) {
        console.log('SKIP container entrypoint: install Tini and put it on PATH');
    } else {
        const service = join(directory, 'service.cjs'), events = join(directory, 'service.log');
        const ready = join(directory, 'framework-ready');
        const managedEnv = { ...env, INIT_TEST_SERVICE: service, INIT_TEST_EVENTS: events, INIT_TEST_READY: ready };
        await writeFile(service, `const fs = require('node:fs');
const name = process.argv[2];
if (name === 'framework') fs.writeFileSync(process.env.INIT_TEST_READY, 'ready');
fs.appendFileSync(process.env.INIT_TEST_EVENTS, name + ':start:' + process.pid + '\\n');
for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR1']) process.on(signal, () => setTimeout(() => { fs.appendFileSync(process.env.INIT_TEST_EVENTS, name + ':stop:' + process.pid + '\\n'); process.exit(0); }, name === 'extra' ? 300 : 0));
setInterval(() => {}, 1000);
`);
        await writeFile(join(init, '00-wait-for-framework.sh'), 'while [[ ! -f "$INIT_TEST_READY" ]]; do sleep 0.05; done\n');
        await writeFile(join(init, '05-loop.sh'), 'trap "exit 0" INT TERM\nprintf "loop:start:%s\\n" "$$" >> "$INIT_TEST_EVENTS"\nwhile true; do\n    node "$INIT_TEST_SERVICE" foreground\n    sleep 0.05\ndone\n');
        await writeFile(join(init, '10-service.sh'), 'exec node "$INIT_TEST_SERVICE" extra\n');
        await writeFile(join(init, '20-failure.sh'), 'exit 7\n');
        let runtime, output = '';
        const waitFor = async check => {
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                if (await check()) return;
                await delay(100);
            }
            throw new Error('Container entrypoint check timed out\n' + output.slice(-4000));
        };
        const serviceEvents = async () => { try { return await lines(events); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
        try {
            for (let start = 0; start < 2; start++) {
                output = '';
                await rm(events, { force: true });
                await rm(ready, { force: true });
                runtime = spawn('tini', ['-s', '--', 'bash', entrypoint, init, process.execPath, service, 'framework'], { env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
                const exited = new Promise((resolve, reject) => { runtime.once('error', reject); runtime.once('exit', (code, signal) => resolve({ code, signal })); });
                runtime.stdout.on('data', chunk => { output += chunk; }); runtime.stderr.on('data', chunk => { output += chunk; });
                await waitFor(async () => { const list = await serviceEvents(); return ['extra', 'framework', 'foreground', 'loop'].every(name => list.some(line => line.startsWith(`${name}:start:`))) && output.includes('20-failure.sh failed (exit 7)'); });
                const before = await serviceEvents();
                const loopPID = Number(before.find(line => line.startsWith('loop:start:')).split(':')[2]);
                process.kill(Number(before.find(line => line.startsWith('foreground:start:')).split(':')[2]), 'SIGKILL');
                await waitFor(async () => (await serviceEvents()).filter(line => line.startsWith('foreground:start:')).length === 2);
                for (const [index, signal] of ['SIGUSR1', 'SIGKILL'].entries()) {
                    const current = (await serviceEvents()).filter(line => line.startsWith('framework:start:')).at(-1);
                    const endedAt = Date.now();
                    process.kill(Number(current.split(':')[2]), signal);
                    await waitFor(async () => (await serviceEvents()).filter(line => line.startsWith('framework:start:')).length === index + 2);
                    assert.ok(Date.now() - endedAt >= 900, 'restart must include a one-second delay');
                }
                const restarted = await serviceEvents();
                assert.equal(restarted.filter(line => line.startsWith('loop:start:')).length, 1, 'Tuxee restarts must not rerun init hooks');
                assert.equal(restarted.filter(line => line.startsWith('extra:start:')).length, 1, 'Tuxee restarts must not duplicate services');
                process.kill(loopPID, 0);
                runtime.kill(start === 0 ? 'SIGTERM' : 'SIGINT');
                await waitFor(() => runtime.exitCode !== null || runtime.signalCode !== null);
                const stopped = await exited;
                assert.equal(stopped.code, 0, output.slice(-4000));
                const after = await serviceEvents();
                assert.ok(after.some(line => line.startsWith('extra:stop:')), 'extra service did not receive shutdown');
                assert.equal(after.filter(line => line.startsWith('framework:stop:')).length, 2, 'framework did not receive shutdown');
                assert.equal(after.filter(line => line.startsWith('framework:start:')).length, 3, 'shutdown must not restart Tuxee');
                assert.ok(after.some(line => line.startsWith('foreground:stop:')), 'foreground service did not receive shutdown');
                await waitFor(() => {
                    try { process.kill(loopPID, 0); return false; }
                    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
                });
                console.log(`PASS independent hooks, framework startup, failure isolation, clean/crash restarts and process-group shutdown (container start ${start + 1})`);
            }
        } finally {
            if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
                runtime.kill('SIGTERM');
                await waitFor(() => runtime.exitCode !== null || runtime.signalCode !== null).catch(() => runtime.kill('SIGKILL'));
            }
        }
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
