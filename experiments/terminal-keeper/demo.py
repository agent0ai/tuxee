#!/usr/bin/python3
"""Interactive client for the keeper experiment; run only in the disposable demo container."""
import errno
import fcntl
import json
import os
from pathlib import Path
import select
import shlex
import signal
import socket
import struct
import sys
import termios
import tty

from check import Terminal, attach, write_all


def main():
    base = Path.home() / ".local/state/tuxee/terminals"
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    session = None
    for endpoint in base.glob("*/keeper.sock"):
        try:
            if json.loads((endpoint.parent / "meta.json").read_text())["instanceId"] != "keeper-demo":
                continue
            control, state, master = attach(endpoint.parent)
        except (FileNotFoundError, ConnectionRefusedError, KeyError, ValueError):
            continue
        if state["flags"] & 4:
            control.close()
            raise SystemExit("Demo shell already attached. Close its other client first.")
        if state["flags"] & 1:
            os.close(master)
            control.send(b"X")
            control.close()
            continue
        session = (endpoint.parent, control, state, master)
        break
    created = session is None
    if created:
        directory = base / os.urandom(12).hex()
        directory.mkdir(mode=0o700)
        (directory / "meta.json").write_text(json.dumps({
            "instanceId": "keeper-demo", "id": directory.name, "state": "live", "name": "Keeper demo",
        }))
        (directory / "meta.json").chmod(0o600)
        terminal = Terminal("/usr/local/lib/tuxee/tuxee-keeper", base,
                            ["/bin/bash", "--noprofile", "--norc", "-i"], raw=False, directory=directory)
        os.close(terminal.errors)
        session = (directory, terminal.control, terminal.state, terminal.master)
    directory, control, state, master = session
    keeper, _, _ = struct.unpack("3i", control.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    print(f"\n{'CREATED' if created else 'REATTACHED'}  shell PID {state['pid']}  |  helper PID {keeper}  |  client PID {os.getpid()}")
    print(f"Socket: {directory}/keeper.sock")
    print("Run `tuxee restart`; after logging back in, open a terminal and run `keeper-demo`.")
    print("Then run `echo $DEMO_VALUE; echo $$` to verify the same shell survived.")
    print("Ctrl+] kills just this demo client. `exit` ends the retained shell.\n", flush=True)
    original = termios.tcgetattr(0)
    def resize(*_):
        size = fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))
        fcntl.ioctl(master, termios.TIOCSWINSZ, size)
    def detach(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGWINCH, resize)
    signal.signal(signal.SIGHUP, detach)
    signal.signal(signal.SIGTERM, detach)
    tty.setraw(0)
    try:
        resize()
        if created:
            command = f"export HOME={shlex.quote(str(Path.home()))} DEMO_VALUE=still-alive; cd /tmp; printf '\\nKeeper demo ready. DEMO_VALUE=%s  Bash PID=%s\\n\\n' \"$DEMO_VALUE\" \"$$\"\n"
            write_all(master, command.encode())
        while True:
            ready, _, _ = select.select([0, master, control], [], [])
            if master in ready:
                try:
                    output = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not output:
                    break
                write_all(1, output)
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    return
                if b"\x1d" in data:
                    os.kill(os.getpid(), signal.SIGKILL)
                write_all(master, data)
            if control in ready and not control.recv(16):
                return
        control.send(b"X")
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, original)
        os.close(master)
        control.close()


if __name__ == "__main__":
    main()
