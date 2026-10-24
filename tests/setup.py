"""Exercise the real embedded update script inside disposable filesystem roots."""
import hashlib
import os
from pathlib import Path
import pty
import re
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import urllib.request


REPO = Path(__file__).resolve().parent.parent


@unittest.skipUnless(os.geteuid() == 0, "requires root for isolated chroot")
class SetupScript(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tuxee-setup-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for command in ("sh", "grep", "id", "cat", "cp", "rm", "mktemp", "awk",
                        "sha256sum", "mkdir", "tar", "gzip", "install", "dirname"):
            source = Path(shutil.which(command))
            target = "/bin/sh" if command == "sh" else "/usr/bin/" + command
            self.copy_executable(source, target)
        self.write("/dev/null", "")
        self.write("/missing-package", "")
        self.write("/mode", "good")
        self.write("/etc/bash.bashrc", '[ -n "$PS1" ] || return\nPS1="TUXEE_READY> "\n# Existing system settings\n')
        (self.root / "tmp").mkdir(mode=0o1777)
        self.write("/update.sh", (REPO / "internal/update/update.sh").read_text())
        self.write("/usr/bin/dpkg-query", """#!/bin/sh
[ "$3" != "$(cat /missing-package)" ] || exit 1
echo 'install ok installed'
""", 0o755)
        self.write("/usr/bin/apt-get", """#!/bin/sh
echo "$*" >> /apt-log
if [ "$(cat /mode)" = apt-failed ]; then exit 100; fi
if [ "$1" = install ]; then
    grep -q '^update ' /apt-log || exit 99
    [ "$DEBIAN_FRONTEND" = noninteractive ] || exit 98
fi
""", 0o755)
        self.write("/usr/bin/curl", """#!/bin/sh
[ "$(cat /mode)" != download-failed ] || exit 22
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) shift; output=$1 ;;
        https://github.com/agent0ai/tuxee/releases/download/v0.2.1/*) asset=${1##*/} ;;
    esac
    shift
done
[ -n "$asset" ] || exit 22
echo "$asset" >> /downloads
cp "/release/$asset" "$output"
""", 0o755)
        for name in ("pulseaudio", "pacat"):
            self.write(f"/bundle/usr/local/lib/tuxee-audio/bin/{name}", "#!/bin/sh\necho audio-fixture\n", 0o755)
            self.write(f"/bundle/usr/local/bin/tuxee-{name}", f"""#!/bin/sh
exec "$(dirname "$0")/../lib/tuxee-audio/bin/{name}" "$@"
""", 0o755)
        (self.root / "release").mkdir()
        for arch in ("amd64", "arm64"):
            asset = f"tuxee-audio-linux-{arch}.tar.gz"
            archive = self.root / "release" / asset
            with tarfile.open(archive, "w:gz") as output:
                output.add(self.root / "bundle", arcname=".")
            with (self.root / "release/checksums.txt").open("a") as output:
                output.write(hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + asset + "\n")

    def copy(self, source, target):
        destination = self.root / target.lstrip("/")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    def copy_executable(self, source, target):
        self.copy(source, target)
        libraries = subprocess.check_output(["ldd", str(source)], text=True)
        for library in re.findall(r"/[^\s()]+", libraries):
            self.copy(Path(library), library)

    def write(self, path, content, mode=0o644):
        target = self.root / path.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        target.chmod(mode)

    def run_script(self, success=True, arch="amd64"):
        result = subprocess.run(["chroot", str(self.root), "/bin/sh", "/update.sh", "0.2.1", arch],
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertEqual(list((self.root / "tmp").iterdir()), [], "temporary downloads leaked")
        return result

    def test_ready_audio_skips_slow_work_and_allows_later_steps(self):
        self.run_script()
        self.assertFalse((self.root / "apt-log").exists())
        self.assertTrue((self.root / "usr/local/lib/tuxee-audio/bin/pulseaudio").is_file())
        downloads = (self.root / "downloads").read_text()
        for command in ("dpkg-query", "apt-get", "curl", "mktemp"):
            self.write("/usr/bin/" + command, "#!/bin/sh\necho unexpected > /slow-work\nexit 99\n", 0o755)
        self.write("/etc/bash.bashrc", '# Existing system settings\n')
        script = (self.root / "update.sh").read_text()
        self.write("/update.sh", script + "\nprintf continued > /next-step\n")
        self.run_script()
        self.assertFalse((self.root / "slow-work").exists())
        self.assertEqual((self.root / "next-step").read_text(), "continued")
        self.assertEqual((self.root / "downloads").read_text(), downloads)
        self.assertIn('13;2u', (self.root / "etc/bash.bashrc").read_text())

    def test_bash_newline_preserves_enter_application_input_and_settings(self):
        self.write("/root/.bashrc", "# Existing user settings\n")
        original = (self.root / "etc/bash.bashrc").read_text()
        self.run_script()
        rc = self.root / "etc/bash.bashrc"
        installed = rc.read_text()
        self.assertTrue(installed.startswith(original))
        self.run_script()
        self.assertEqual(rc.read_text(), installed)
        self.assertEqual((self.root / "root/.bashrc").read_text(), "# Existing user settings\n")

        master, slave = pty.openpty()
        env = dict(os.environ, TERM="xterm-256color", PS1="TUXEE_READY> ",
                   INPUTRC="/dev/null", HISTFILE="/dev/null")
        shell = subprocess.Popen(["bash", "--noprofile", "--rcfile", str(rc), "-i"],
                                 stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)

        def read_until(expected):
            output = b""
            deadline = time.monotonic() + 5
            while expected not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    output += os.read(master, 65536)
            self.assertIn(expected, output)
            return re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output).replace(b'\r', b'')

        try:
            read_until(b"TUXEE_READY> ")
            os.write(master, b"echo first\x1b[13;2uecho second")
            self.assertNotIn(b"\nfirst\n", read_until(b"echo second"))
            os.write(master, b"\r")
            self.assertIn(b"first\nsecond\n", read_until(b"TUXEE_READY> "))
            code = "import os,tty;tty.setraw(0);print('RAW'+'READY',flush=True);print(os.read(0,7).hex(),flush=True)"
            os.write(master, (shlex.quote(sys.executable) + " -c " + shlex.quote(code) + "\r").encode())
            read_until(b"RAWREADY")
            os.write(master, b"\x1b[13;2u")
            read_until(b"1b5b31333b3275")
        finally:
            os.killpg(shell.pid, signal.SIGKILL)
            shell.wait()
            os.close(master)

    def test_partial_runtime_is_repaired_before_later_steps(self):
        self.run_script()
        (self.root / "usr/local/bin/tuxee-pacat").unlink()
        script = (self.root / "update.sh").read_text()
        self.write("/update.sh", script + "\n/usr/local/bin/tuxee-pacat --version > /next-step\n")
        self.run_script()
        self.assertEqual((self.root / "next-step").read_text(), "audio-fixture\n")

    def test_missing_package_refreshes_apt_before_install(self):
        self.write("/missing-package", "libcap2")
        self.run_script(arch="arm64")
        commands = (self.root / "apt-log").read_text().splitlines()
        self.assertEqual(commands, ["update -o APT::Update::Error-Mode=any",
                                   "install -y --no-install-recommends -o DPkg::Lock::Timeout=60 libcap2", "clean"])

    def test_apt_failure_stops_before_download_or_install(self):
        self.write("/missing-package", "libcap2")
        self.write("/mode", "apt-failed")
        self.run_script(False)
        self.assertFalse((self.root / "downloads").exists())
        self.assertFalse((self.root / "usr/local").exists())

    def test_invalid_checksums_never_install(self):
        checksums = (self.root / "release/checksums.txt").read_text()
        for value in ("", checksums + checksums, "0" * 64 + "  tuxee-audio-linux-amd64.tar.gz\n"):
            with self.subTest(checksums=value):
                self.write("/release/checksums.txt", value)
                self.run_script(False)
                self.assertFalse((self.root / "usr/local").exists())

    def test_failed_download_can_retry(self):
        self.write("/mode", "download-failed")
        self.run_script(False)
        self.assertFalse((self.root / "usr/local").exists())
        self.write("/mode", "good")
        self.run_script()

    def test_invalid_runtime_never_installs(self):
        self.write("/bundle/usr/local/lib/tuxee-audio/bin/pulseaudio", "#!/bin/sh\nexit 1\n", 0o755)
        archive = self.root / "release/tuxee-audio-linux-amd64.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            output.add(self.root / "bundle", arcname=".")
        self.write("/release/checksums.txt", hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n")
        self.run_script(False)
        self.assertFalse((self.root / "usr/local").exists())

    @unittest.skipUnless(os.environ.get("TUXEE_SETUP_TEST_BINARY"), "supply a 0.2.1 test binary for server startup checks")
    def test_server_startup_and_completion_markers(self):
        self.copy_executable(Path(os.environ["TUXEE_SETUP_TEST_BINARY"]), "/usr/local/lib/tuxee/tuxee")
        # This mount-free chroot needs the real child's startup identity; restart tests use live procfs.
        self.write("/proc/sys/kernel/random/boot_id", Path("/proc/sys/kernel/random/boot_id").read_text())
        (self.root / "proc/self").mkdir()
        (self.root / "proc/self/exe").symlink_to("/usr/local/lib/tuxee/tuxee")

        def capture_child_identity():
            (self.root / "proc/self/stat").write_text(Path("/proc/self/stat").read_text())

        # Keep the ordinary release checker inside the fixture too.
        self.write("/etc/hosts", "127.0.0.1 api.github.com\n")
        environment = {"PATH": os.environ["PATH"], "LANG": "C"}
        command = ["chroot", str(self.root), "/usr/local/lib/tuxee/tuxee"]
        marker = self.root / "usr/local/lib/tuxee/update-version"

        def serve():
            with (self.root / "server.log").open("w+") as log:
                process = subprocess.Popen(command + ["serve", "--http", "--bind", "127.0.0.1:0",
                                                     "--state", "/var/lib/tuxee"],
                                           stdout=log, stderr=log, env=environment,
                                           preexec_fn=capture_child_identity)
                try:
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        log.seek(0)
                        output = log.read()
                        match = re.search(r"listening at (http://127\.0\.0\.1:\d+)", output)
                        if match:
                            with urllib.request.urlopen(match[1], timeout=3) as response:
                                self.assertEqual(response.status, 200)
                            return output
                        self.assertIsNone(process.poll(), output)
                        time.sleep(0.02)
                    self.fail("server startup timed out: " + output)
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()

        # Native starts and CLI version probes must never perform setup.
        self.assertNotIn("preparing container", serve())
        self.assertFalse(marker.exists())
        self.assertNotIn('13;2u', (self.root / "etc/bash.bashrc").read_text())
        self.write("/opt/tuxee/entrypoint.sh", "#!/bin/sh\n")
        result = subprocess.run(command + ["version"], capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, "Tuxee 0.2.1\n")
        self.assertFalse(marker.exists())

        # A fresh image skips even with an old reused data volume and no network.
        self.write("/usr/local/lib/tuxee/update-version", "0.2.1\n")
        self.write("/var/lib/tuxee/update-version", "0.2.0\n")
        self.write("/mode", "download-failed")
        self.assertNotIn("preparing container", serve())
        self.assertFalse((self.root / "downloads").exists())

        # A legacy image has no marker. Failure still serves the UI and retries.
        marker.unlink()
        self.write("/var/lib/tuxee/update-version", "0.2.1\n")
        self.assertIn("setup failed; will retry", serve())
        self.assertFalse(marker.exists())
        self.write("/mode", "good")
        self.assertIn("audio runtime installed", serve())
        self.assertEqual(marker.read_text(), "0.2.1\n")
        self.assertIn('13;2u', (self.root / "etc/bash.bashrc").read_text())
        self.write("/mode", "download-failed")
        self.assertNotIn("preparing container", serve())


if __name__ == "__main__":
    unittest.main(verbosity=2)
