#!/usr/bin/env python3
"""Real Linux PTYs; no mocked keeper, transport or process lifecycle."""
import array
import ctypes
import fcntl
import hashlib
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import socket
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import tty


def until(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.005)
    raise AssertionError("condition timed out")


def memory(pid):
    values = {}
    for line in pathlib.Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines()[1:]:
        key, value = line.split(":", 1)
        values[key] = int(value.split()[0])
    return {key: values[key] for key in ("Rss", "Pss", "Private_Clean", "Private_Dirty", "Swap")}


def packet(control):
    data, messages, flags, _ = control.recvmsg(16, socket.CMSG_SPACE(4), socket.MSG_CMSG_CLOEXEC)
    assert not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC), flags
    assert len(data) == 16, data
    version, pid, state, status = struct.unpack("!IIII", data)
    assert version == 1
    descriptors = []
    for level, kind, payload in messages:
        assert (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS)
        descriptors.extend(array.array("i", payload))
    assert len(descriptors) <= 1
    return {"pid": pid, "flags": state, "status": status}, descriptors[0] if descriptors else None


def attach(directory):
    pinned = os.open(directory, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    control = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    control.settimeout(3)
    try:
        control.connect(f"/proc/self/fd/{pinned}/keeper.sock")
        state, master = packet(control)
        return control, state, master
    except BaseException:
        control.close()
        raise
    finally:
        os.close(pinned)


def launch(binary, directory, command, raw=True, uid=None, extra_fd=None):
    master, slave = pty.openpty()
    if raw:
        tty.setraw(slave)
    if uid is not None:
        os.chown(directory, uid, uid)
        os.fchown(slave, uid, uid)
    pinned = os.open(directory, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    errors, error_writer = os.pipe()
    sources = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 20) for fd in (master, slave, pinned, error_writer)]
    child = os.fork()
    if child == 0:
        try:
            for source, target in zip(sources, (3, 4, 5, 2)):
                os.dup2(source, target)
            if extra_fd is not None:
                os.dup2(extra_fd, 19)
            if uid is not None:
                os.setgroups([])
                os.setgid(uid)
                os.setuid(uid)
            os.chdir("/tmp")
            os.execve(binary, [binary, *command], {
                "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(directory),
                "TERM": "xterm-256color", "LANG": "C.UTF-8", "PS1": "keeper> ",
            })
        except BaseException as error:
            os.write(2, str(error).encode())
            os._exit(125)
    for fd in (master, slave, pinned, error_writer, *sources):
        os.close(fd)
    return child, errors


class Terminal:
    def __init__(self, binary, root, command=None, raw=True, uid=None, directory=None):
        self.directory = pathlib.Path(directory or tempfile.mkdtemp(dir=root))
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.pid, self.errors = launch(binary, self.directory, command or [sys.executable, __file__, "--echo"], raw, uid)
        self.control = None
        self.master = None
        self.state = None
        try:
            assert select.select([self.errors], [], [], 3)[0], "keeper startup timed out"
            diagnostic = os.read(self.errors, 4096)
            assert not diagnostic, diagnostic.decode(errors="replace")
            self.connect()
        except BaseException:
            self.close()
            raise

    def connect(self):
        def attempt():
            control, state, master = attach(self.directory)
            if state["flags"] & 4:
                control.close()
                return False
            assert master is not None
            peer_pid, _, _ = struct.unpack("3i", control.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            assert peer_pid == self.pid
            self.control, self.state, self.master = control, state, master
            return True
        until(attempt)
        assert not os.get_inheritable(self.master)

    def detach(self):
        if self.master is not None:
            os.close(self.master)
            self.master = None
        if self.control:
            self.control.close()
            self.control = None

    def close(self):
        try:
            if self.control is None and (self.directory / "keeper.sock").exists():
                self.connect()
            if self.master is not None:
                os.close(self.master)
                self.master = None
            if self.control:
                self.control.send(b"X")
                self.control.close()
                self.control = None
            wait_dead(self.pid)
        except (OSError, AssertionError):
            try:
                os.kill(self.pid, signal.SIGTERM)
                wait_dead(self.pid)
            except (OSError, AssertionError):
                try:
                    os.kill(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        finally:
            self.detach()
            if self.errors is not None:
                diagnostic = os.read(self.errors, 4096)
                os.close(self.errors)
                self.errors = None
                assert not diagnostic, diagnostic.decode(errors="replace")


def wait_dead(pid):
    def dead():
        try:
            found, _ = os.waitpid(pid, os.WNOHANG)
            return found == pid
        except ChildProcessError:
            return not pathlib.Path(f"/proc/{pid}").exists()
    until(dead)


def read_exact(fd, count, timeout=15):
    result = bytearray()
    deadline = time.monotonic() + timeout
    while len(result) < count:
        assert select.select([fd], [], [], max(0, deadline - time.monotonic()))[0], (len(result), count)
        result.extend(os.read(fd, min(65536, count - len(result))))
    return bytes(result)


def read_until(fd, marker, timeout=5):
    result = bytearray()
    deadline = time.monotonic() + timeout
    while marker not in result:
        assert select.select([fd], [], [], max(0, deadline - time.monotonic()))[0], bytes(result)
        result.extend(os.read(fd, 65536))
    return bytes(result)


def write_all(fd, value):
    while value:
        value = value[os.write(fd, value):]


def latency(fd, count=2000):
    timings = []
    for _ in range(count + 100):
        start = time.perf_counter_ns()
        os.write(fd, b"x")
        assert os.read(fd, 1) == b"x"
        timings.append((time.perf_counter_ns() - start) / 1000)
    timings = sorted(timings[100:])
    return {"p50_us": statistics.median(timings), "p95_us": timings[int(count * .95)],
            "p99_us": timings[int(count * .99)], "max_us": max(timings)}


def owner(binary, directory):
    terminal = Terminal(binary, directory.parent, ["/bin/bash", "--noprofile", "--norc", "-i"],
                        raw=False, directory=directory)
    os.write(terminal.master, b"KEEPER_VALUE=preserved; cd /tmp; printf '\\nOWNER_READY\\n'\n")
    read_until(terminal.master, b"\r\nOWNER_READY\r\n")
    print(json.dumps({"keeper": terminal.pid, "shell": terminal.state["pid"]}), flush=True)
    while True:
        signal.pause()


def crash_recovery(binary, root):
    directory = pathlib.Path(tempfile.mkdtemp(dir=root))
    process = subprocess.Popen([sys.executable, __file__, "--owner", binary, str(directory)], stdout=subprocess.PIPE)
    info = json.loads(process.stdout.readline())
    process.kill()
    process.wait(timeout=5)
    control, state, master = attach(directory)
    assert state["pid"] == info["shell"] and not state["flags"]
    command = b"printf '\\nRECOVERED:%s:%s:%s\\n' \"$$\" \"$KEEPER_VALUE\" \"$PWD\"\n"
    os.write(master, command)
    expected = f"\r\nRECOVERED:{info['shell']}:preserved:/tmp\r\n".encode()
    read_until(master, expected)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 41, 137, 0, 0))
    os.write(master, b"stty size; printf '\\nSIZE_DONE\\n'\n")
    assert b"41 137\r\n" in read_until(master, b"\r\nSIZE_DONE\r\n")
    os.write(master, b"sleep 60\n")
    time.sleep(.03)
    os.write(master, b"\x03printf '\\nINTERRUPTED\\n'\n")
    read_until(master, b"\r\nINTERRUPTED\r\n")
    os.close(master)
    control.send(b"X")
    control.close()
    until(lambda: not (directory / "keeper.sock").exists())
    wait_dead(info["keeper"])
    return info


def rejection(binary, root, kind):
    directory = pathlib.Path(tempfile.mkdtemp(dir=root))
    target = directory / "keeper.sock"
    if kind == "symlink":
        target.symlink_to("keep-me")
    elif kind == "file":
        target.write_text("keep-me")
    elif kind == "permissions":
        directory.chmod(0o755)
    pid, errors = launch(binary, directory, ["/bin/sleep", "60"])
    _, status = os.waitpid(pid, 0)
    diagnostic = os.read(errors, 4096)
    os.close(errors)
    assert os.waitstatus_to_exitcode(status) != 0 and diagnostic
    if kind == "symlink":
        assert target.is_symlink()
    elif kind == "file":
        assert target.read_text() == "keep-me"


def check_binary(binary, root):
    result = {"binary_bytes": os.stat(binary).st_size}
    term = Terminal(binary, root)
    try:
        assert (term.directory / "keeper.sock").stat().st_mode & 0o777 == 0o600
        result["idle_memory_kib"] = memory(term.pid)
        result["keeper_fds"] = len(list(pathlib.Path(f"/proc/{term.pid}/fd").iterdir()))
        before = pathlib.Path(f"/proc/{term.pid}/stat").read_text().split()[13:15]
        time.sleep(.1)
        assert before == pathlib.Path(f"/proc/{term.pid}/stat").read_text().split()[13:15]
        control, state, descriptor = attach(term.directory)
        assert state["flags"] & 4 and descriptor is None
        control.close()
        other, errors = launch(binary, term.directory, ["/bin/sleep", "60"])
        _, status = os.waitpid(other, 0)
        assert os.waitstatus_to_exitcode(status) != 0 and os.read(errors, 4096)
        os.close(errors)
        assert (term.directory / "keeper.sock").exists()
        for index in range(100):
            data = f"attach-{index:04d}".encode()
            os.write(term.master, data)
            assert read_exact(term.master, len(data)) == data
            term.detach()
            term.connect()
        for malformed in (b"?", b"XX", b"X" * 1000):
            os.close(term.master)
            term.master = None
            term.control.send(malformed)
            assert term.control.recv(16) == b""
            term.detach()
            term.connect()
            assert not term.state["flags"]
        result["roundtrip"] = latency(term.master)
        payload = bytes(range(256)) * 32768
        started = time.monotonic()
        writer = threading.Thread(target=write_all, args=(term.master, payload))
        writer.start()
        assert read_exact(term.master, len(payload)) == payload
        writer.join(5)
        assert not writer.is_alive()
        result["echo_mib_per_second"] = 8 / (time.monotonic() - started)
        result["active_memory_kib"] = memory(term.pid)
    finally:
        term.close()
    assert not (term.directory / "keeper.sock").exists()

    result["crash_recovery"] = crash_recovery(binary, root)
    for kind in ("symlink", "file", "permissions"):
        rejection(binary, root, kind)

    # Inherited handles cannot leak into either the guardian or its shell.
    secret_read, secret_write = os.pipe()
    directory = pathlib.Path(tempfile.mkdtemp(dir=root))
    pid, errors = launch(binary, directory, ["/bin/sleep", "60"], extra_fd=secret_write)
    os.close(secret_write)
    try:
        assert select.select([secret_read], [], [], 3)[0]
        assert os.read(secret_read, 1) == b"", "inherited descriptor leaked"
    finally:
        os.close(secret_read)
        os.kill(pid, signal.SIGTERM)
        wait_dead(pid)
        assert not os.read(errors, 4096)
        os.close(errors)

    # Keeper failure kills its shell, leaves a discoverably stale socket and permits safe reuse.
    term = Terminal(binary, root)
    directory, shell = term.directory, term.state["pid"]
    term.detach()
    os.kill(term.pid, signal.SIGKILL)
    wait_dead(term.pid)
    wait_dead(shell)
    assert (directory / "keeper.sock").exists()
    assert not os.read(term.errors, 4096)
    os.close(term.errors)
    term.errors = None
    term = Terminal(binary, root, directory=directory)
    term.close()

    # A long metadata path still binds/connects through a pinned directory descriptor.
    long_path = pathlib.Path(root) / ("a" * 100) / ("b" * 100) / ("c" * 24)
    term = Terminal(binary, root, directory=long_path)
    term.close()

    # A full PTY blocks its writer; reconnection recovers every unread byte in order.
    done = pathlib.Path(root) / "flood-complete"
    done.unlink(missing_ok=True)
    term = Terminal(binary, root, [sys.executable, __file__, "--flood", str(done)])
    try:
        term.detach()
        time.sleep(.15)
        assert not done.exists(), "writer bypassed expected PTY backpressure"
        result["disconnected_memory_kib"] = memory(term.pid)
        term.connect()
        expected = bytes(range(256)) * 262144
        received = read_exact(term.master, len(expected))
        assert hashlib.sha256(received).digest() == hashlib.sha256(expected).digest()
        until(done.exists)
        state, descriptor = packet(term.control)
        assert state["flags"] & 1 and state["status"] == 0 and descriptor is None
        term.detach()
        term.connect()
        assert term.state["flags"] & 1
        result["disconnected_output_bytes_verified"] = len(expected)
    finally:
        term.close()

    # Natural exit while nobody is attached retains final unread output until acknowledged.
    term = Terminal(binary, root, ["/bin/sh", "-c", "sleep .1; printf FINAL; exit 23"])
    try:
        term.detach()
        time.sleep(.2)
        term.connect()
        assert term.state["flags"] & 1 and term.state["status"] == 23
        assert read_exact(term.master, 5) == b"FINAL"
    finally:
        term.close()

    # Explicit termination is bounded even when the shell ignores HUP/TERM.
    term = Terminal(binary, root, ["/bin/sh", "-c", "trap '' HUP TERM; printf READY; exec sleep 300"])
    read_exact(term.master, 5)
    shell = term.state["pid"]
    started = time.monotonic()
    term.close()
    assert not pathlib.Path(f"/proc/{shell}").exists()
    result["forced_close_seconds"] = time.monotonic() - started
    assert result["forced_close_seconds"] < 3

    # A terminal owns disowned/new-session descendants too, not just its initial shell group.
    program = ("import os,signal,time; signal.signal(signal.SIGHUP,signal.SIG_IGN); "
               "signal.signal(signal.SIGTERM,signal.SIG_IGN); child=os.fork(); "
               "os.setsid() if child==0 else print(child,flush=True); time.sleep(300)")
    term = Terminal(binary, root, [sys.executable, "-c", program])
    descendant = int(read_until(term.master, b"\n").strip())
    try:
        term.close()
        assert not pathlib.Path(f"/proc/{descendant}").exists(), "detached descendant leaked"
    finally:
        try:
            os.kill(descendant, signal.SIGKILL)
        except ProcessLookupError:
            pass

    # Orphan exits must be reaped while the original shell stays alive.
    program = """import os,time
child=os.fork()
if child == 0:
    orphan=os.fork()
    if orphan == 0:
        time.sleep(.05)
        os._exit(0)
    print(orphan,flush=True)
    os._exit(0)
os.waitpid(child,0)
time.sleep(300)
"""
    term = Terminal(binary, root, [sys.executable, "-c", program])
    orphan = int(read_until(term.master, b"\n").strip())
    try:
        until(lambda: not pathlib.Path(f"/proc/{orphan}").exists())
    finally:
        term.close()

    # No per-byte relay: one direct PTY descriptor has the same data path after transfer.
    master, slave = pty.openpty()
    tty.setraw(slave)
    echo = subprocess.Popen([sys.executable, __file__, "--echo"], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    try:
        result["direct_roundtrip"] = latency(master)
        assert result["roundtrip"]["p50_us"] - result["direct_roundtrip"]["p50_us"] < 1000
    finally:
        os.close(master)
        echo.wait(timeout=5)

    terms = []
    try:
        for _ in range(32):
            terms.append(Terminal(binary, root))
        samples = [memory(term.pid) for term in terms]
        result["32_keepers_memory_kib"] = {key: sum(item[key] for item in samples) for key in samples[0]}
        addresses = set()
        for term in terms:
            executable = os.readlink(f"/proc/{term.pid}/exe")
            mapping = next(line for line in pathlib.Path(f"/proc/{term.pid}/maps").read_text().splitlines()
                           if "r-xp" in line and line.endswith(" " + executable))
            addresses.add(mapping.split("-", 1)[0])
        result["distinct_load_addresses"] = len(addresses)
        if not binary.endswith("-fixed"):
            assert len(addresses) > 1, "PIE address randomization missing"
    finally:
        for term in terms:
            term.close()
    result["passed"] = True
    return result


def access_checks(binary, root):
    if os.geteuid() != 0:
        return "requires root"
    executable = pathlib.Path(root) / "keeper-access"
    script = pathlib.Path(root) / "echo.py"
    shutil.copyfile(binary, executable)
    executable.chmod(0o755)
    shutil.copyfile(__file__, script)
    script.chmod(0o644)
    term = Terminal(str(executable), root, [sys.executable, str(script), "--echo"], uid=65534)
    try:
        os.write(term.master, b"same-user")
        assert read_exact(term.master, 9) == b"same-user"
        term.detach()
        # Relax filesystem access deliberately to exercise SO_PEERCRED independently.
        term.directory.chmod(0o755)
        (term.directory / "keeper.sock").chmod(0o666)
        for uid, accepted in ((65533, False), (65534, True)):
            child = os.fork()
            if child == 0:
                os.setgroups([])
                os.setgid(uid)
                os.setuid(uid)
                try:
                    control, _, master = attach(term.directory)
                    assert accepted and master is not None
                    os.close(master)
                    control.close()
                    os._exit(0)
                except (OSError, AssertionError):
                    os._exit(0 if not accepted else 1)
            _, status = os.waitpid(child, 0)
            assert status == 0, (uid, status)
    finally:
        term.close()
    return "same UID/root accepted; other UID rejected even with permissive socket mode"


def main():
    assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
    binaries = sys.argv[1:] or [str(path) for path in sorted(pathlib.Path("/keepers").iterdir())]
    root = tempfile.mkdtemp(prefix="tuxee-keeper-check-")
    os.chmod(root, 0o711)
    result = {"kernel": os.uname().release, "architecture": os.uname().machine, "variants": {}}
    try:
        for binary in binaries:
            print(f"checking {binary}", file=sys.stderr, flush=True)
            result["variants"][pathlib.Path(binary).name] = check_binary(binary, root)
        result["access"] = access_checks(binaries[0], root)
        print(json.dumps(result, indent=2), flush=True)
    finally:
        shutil.rmtree(root)


def service(binary):
    """A disposable server fixture under Tuxee's real Docker entrypoint."""
    base = pathlib.Path.home() / ".local/state/tuxee/terminals"
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    found = None
    for endpoint in base.glob("*/keeper.sock"):
        meta = json.loads((endpoint.parent / "meta.json").read_text())
        if meta["instanceId"] != "keeper-experiment":
            continue
        try:
            control, state, master = attach(endpoint.parent)
        except (ConnectionRefusedError, FileNotFoundError):
            continue
        assert master is not None and state["flags"] == 0
        found = (endpoint.parent, control, state, master)
        break
    if found:
        directory, control, state, master = found
    else:
        directory = base / os.urandom(12).hex()
        directory.mkdir(mode=0o700)
        (directory / "meta.json").write_text(json.dumps({
            "instanceId": "keeper-experiment", "id": directory.name, "state": "live", "name": "Terminal",
        }))
        term = Terminal(binary, base, ["/bin/bash", "--noprofile", "--norc", "-i"], raw=False, directory=directory)
        control, state, master = term.control, term.state, term.master
        os.write(master, b"KEEPER_GENERATION=0; cd /tmp\n")
    os.write(master, b"KEEPER_GENERATION=$((KEEPER_GENERATION+1)); printf '\\nGEN:%s:END\\n' \"$KEEPER_GENERATION\"\n")
    output = read_until(master, b":END\r\n")
    generation = int(output.rsplit(b"\r\nGEN:", 1)[1].split(b":", 1)[0])
    keeper, _, _ = struct.unpack("3i", control.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    print(json.dumps({"ready": True, "server": os.getpid(), "keeper": keeper, "shell": state["pid"],
                      "generation": generation, "socket": str(directory / "keeper.sock")}), flush=True)
    while True:
        signal.pause()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--echo"]:
        try:
            while data := os.read(0, 65536):
                write_all(1, data)
        except OSError:
            pass
    elif sys.argv[1:2] == ["--flood"]:
        block = bytes(range(256)) * 16
        for _ in range(16384):
            write_all(1, block)
        pathlib.Path(sys.argv[2]).touch()
    elif sys.argv[1:2] == ["--owner"]:
        owner(sys.argv[2], pathlib.Path(sys.argv[3]))
    elif sys.argv[1:2] == ["--service"]:
        service(sys.argv[2])
    else:
        main()
