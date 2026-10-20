#!/usr/bin/env python3
"""Write release notes from the tag's reachable commit history."""
import re
import subprocess
import sys


def version(tag):
    if not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("Expected vMAJOR.MINOR.PATCH")
    return tuple(map(int, tag[1:].split(".")))


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def notes(tag):
    current = version(tag)
    tags = git("tag", "--merged", tag).splitlines()
    previous = []
    for candidate in tags:
        try:
            if version(candidate) < current:
                previous.append(candidate)
        except ValueError:
            pass
    prior = max(previous, key=version) if previous else ""
    history = git("log", "--reverse", "--format=- %s (%h)%n%b", f"{prior}..{tag}" if prior else tag)
    return f"## Changes{f' since {prior}' if prior else ''}\n\n{history}\n"


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as path:
            os.chdir(path)
            git("init", "-q", "-b", "main")
            git("config", "user.name", "Release test")
            git("config", "user.email", "release@example.invalid")
            git("commit", "--allow-empty", "-qm", "First commit")
            git("tag", "v0.1.0")
            assert "First commit" in notes("v0.1.0")
            git("commit", "--allow-empty", "-qm", "Second commit\n\nDetailed explanation.")
            git("commit", "--allow-empty", "-qm", "Third commit")
            git("tag", "v0.2.0")
            result = notes("v0.2.0")
            assert all(value in result for value in ["since v0.1.0", "Second commit", "Detailed explanation.", "Third commit"])
            assert "First commit" not in result
        assert version("v1.10.0") > version("v1.9.0")
        for invalid in ["v1", "1.2.3", "v01.2.3", "v1.2.3-rc.1", "v1.2.3\n"]:
            try:
                version(invalid)
            except ValueError:
                continue
            raise AssertionError(invalid)
        print("Release notes checks passed")
    else:
        print(notes(sys.argv[1]), end="")
