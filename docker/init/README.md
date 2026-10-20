# Container startup scripts

Place Bash scripts in `/init`, for example `my-service.sh` and `another-service.sh`.
On every container start or restart, a background job launches all top-level
`*.sh` files independently in parallel alongside Tuxee. Tuxee starts independently
and never waits for these scripts. There is no execution order guarantee; put
dependent preparation and startup commands in the same script. An empty folder is fine.

Scripts run as root inside the container, each in a separate Bash process with
`/init` as its working directory. They do not need executable permission. Hidden
files, subdirectories, Markdown and other file types are ignored. Environment
changes in one script do not carry over to other scripts or Tuxee.
Root password initialization finishes before scripts start; `ROOT_PASSWORD` is
removed from their environment.

Scripts may run forever. One script blocking, exiting or crashing does not stop
the others or Tuxee. Failures are reported in the container logs. Make scripts
safe to run repeatedly.
The init runner runs once per container start, without automatic restart;
restarting Tuxee alone does not rerun it. Completed or failed scripts stay stopped
until the next container start. On shutdown, the runner terminates each script's
process group, including its child processes. Native Tuxee installations do not
use this folder.

## Start a service that stays running

Run a service directly in the foreground. For example, save this as
`/init/my-service.sh`, after placing your application in `/root/my-service`:

```bash
#!/bin/bash
set -e
cd /root/my-service
exec ./server
```

To restart a program whenever it exits, keep a loop in its script:

```bash
#!/bin/bash
cd /root/my-service || exit 1
trap 'exit 0' INT TERM
while true; do
    ./server || true
    sleep 1
done
```

Keep services in the foreground; the init runner already launches each script
in the background. The one-second delay avoids a tight loop if startup fails.

Install any dependencies your service needs. Node, npm and PM2 are not bundled.
Tuxee has its own restart loop with a one-second delay.

Service output and init failures appear in `docker compose logs -f tuxee`.
Publish any additional service ports in your Docker configuration.

## Keep your scripts

The supplied Compose configuration stores `/init` in the `tuxee-init` volume,
so scripts survive container recreation and can be edited in Tuxee's file browser.
For host-managed scripts, replace that volume mount with `./my-init:/init` (add
`:ro` if you only want to edit them on the host). A bind mount hides this bundled
README; copy it into your host folder if you want to keep it visible.

Restart the container to run changed scripts.
