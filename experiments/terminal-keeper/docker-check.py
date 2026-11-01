#!/usr/bin/env python3
"""Run disposable Docker measurements and the production entrypoint lifecycle."""
import json
import os
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "test-results/terminal-keeper"
ENV = {**os.environ, "DOCKER_HOST": os.environ.get("DOCKER_HOST", "unix:///root/.docker-dev/docker.sock")}


def docker(*args):
    return subprocess.check_output(["docker", *args], env=ENV, text=True, stderr=subprocess.STDOUT)


def build(target):
    tag = "tuxee:terminal-keeper-" + target
    with (OUT / (target + "-build.log")).open("w") as log:
        subprocess.run(["docker", "build", "--target", target, "-t", tag, str(HERE)],
                       env=ENV, stdout=log, stderr=subprocess.STDOUT, check=True)
    return tag


def ready(name, generation):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        records = []
        for line in docker("logs", name).splitlines():
            if line.startswith('{"ready":'):
                records.append(json.loads(line))
        if records and records[-1]["generation"] == generation:
            return records[-1]
        time.sleep(.1)
    raise AssertionError(docker("logs", name))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    checks = build("checks")
    with (OUT / "docker.json").open("w") as output:
        subprocess.run(["docker", "run", "--rm", "--name", "tuxee-terminal-keeper-measure", checks],
                       env=ENV, stdout=output, check=True)
    runtime = build("tuxee-runtime")
    sizes = json.loads(docker("image", "inspect", "agent0ai/tuxee:latest", runtime))
    assert sizes[1]["RootFS"]["Layers"][:len(sizes[0]["RootFS"]["Layers"])] == sizes[0]["RootFS"]["Layers"], "base image changed during measurement"
    result = {"base_image": sizes[0]["Id"], "runtime_image": sizes[1]["Id"],
              "base_bytes": sizes[0]["Size"], "runtime_bytes": sizes[1]["Size"],
              "added_image_bytes": sizes[1]["Size"] - sizes[0]["Size"]}
    lifecycle = build("lifecycle-checks")
    name = "tuxee-terminal-keeper-lifecycle"
    docker("run", "-d", "--name", name, lifecycle)
    try:
        first = ready(name, 1)
        result["restarts"] = [first]
        current = first
        for generation in range(2, 12):
            if generation == 6:
                # Replacing the on-disk helper must not affect already running sessions.
                docker("exec", name, "sh", "-c", "cp /usr/local/lib/tuxee/tuxee-keeper /usr/local/lib/tuxee/keeper.new && mv /usr/local/lib/tuxee/keeper.new /usr/local/lib/tuxee/tuxee-keeper")
            docker("exec", name, "kill", "-KILL", str(current["server"]))
            current = ready(name, generation)
            assert current["keeper"] == first["keeper"] and current["shell"] == first["shell"]
            assert current["socket"] == first["socket"]
            result["restarts"].append(current)
        docker("stop", "--time", "5", name)
        assert docker("inspect", "--format", "{{.State.Status}}", name).strip() == "exited"
        result["container_shutdown"] = "passed"
    finally:
        docker("rm", "-f", "-v", name)
    (OUT / "docker-lifecycle.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
