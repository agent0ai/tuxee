# Updates and releases

## Install

See [installation](install.md) for requirements, the install script, manual
binary downloads, boot startup and source builds.

The installer pins GitHub's latest-release redirect to one tag and verifies the
checksum and executable version before installation. Selecting an explicit
older version also allows rollback; configuration and state are preserved.

`https://tuxee.agent-zero.ai/` may redirect to the repository;
`/install.sh` must serve or redirect to
`https://raw.githubusercontent.com/agent0ai/tuxee/main/install.sh` over valid HTTPS.
The public install command needs both the committed script and a completed
release containing the native bootstrap command. Checking in a workflow does
not create that first release.

## Update

For versions without `tuxee update`, rerun the
[install script](install.md#update-an-older-installation). It upgrades the default
installation using the downloaded binary, preserving configuration and state.
Restart the server explicitly when ready.

```sh
tuxee update --check
sudo tuxee update
# For an older separate service copy or a named service:
sudo tuxee update --name tuxee
sudo tuxee update --name my-tuxee
```

`tuxee upgrade` is an alias for `tuxee update` and accepts the same options.

By default the command updates the executable it was invoked from, resolving
symlinks. `--name` selects that managed service's executable instead. The default
installer and Docker image share one binary between PATH and the server; named
services retain their separate installation paths. About and CLI restart hints
use `tuxee` when PATH lookup resolves through
symlinks to the same installation; otherwise they show its quoted absolute path.
About adds sudo for non-root users. The lookup checks the calling process's PATH;
customized user shells and sudo may have different paths.

The updater checks the latest stable release and compares semantic versions.
Equal/newer installed versions stay unchanged. Downloads are bounded, checked
against the release's SHA-256, tested with `version`, synced and renamed over the
target atomically under an installation lock. Failed downloads, checksums or
compatibility checks preserve the executable. Read-only mounts and unwritable
installation directories fail explicitly. A binary mounted as an individual
bind-mounted file must be updated on its host, because it cannot be renamed
inside the container.

Checksums detect corrupt or mismatched downloads; release authenticity depends
on HTTPS and control of the official GitHub repository.

Running processes keep their current code. Authentication and file helpers
execute the running inode via `/proc/self/exe`, so they stay on the same version
after replacement. Configuration, user files and terminals are unchanged by
the update. **Restarting ends all terminal sessions.**

When ready, run `sudo tuxee restart` (with `--name` for a named installation).
This uses the same runtime cleanup/re-exec as the UI for foreground, systemd and
Docker deployments. Use `--state /path` to select among instances sharing a binary.
All systemd controls now live under `tuxee service`, including `tuxee service restart`.
Older running servers need one restart through the UI or their service/supervisor
before they support the new CLI trigger. Updates never restart automatically.

Update results print a blank line, green success or red failure, another blank
line, the reminder that changes take effect after restarting and that restarting
kills all running terminals, then `Restart using:` with the command in yellow.
Failures return a nonzero exit status, so `tuxee update && tuxee restart` only
requests restart after a successful update command (including already up to date).
Use `sudo tuxee update && sudo tuxee restart` outside a root shell. Colors are
omitted for redirected output, `NO_COLOR`, and `TERM=dumb`.

An executable's successful version check does not establish every runtime
behavior of a release; an explicit older installer version is available if needed.

## Docker updates

Compose uses the multi-platform `agent0ai/tuxee:latest` image. Version tags
`agent0ai/tuxee:v1.2.3` and `agent0ai/tuxee:1.2.3` select a specific release.

For a complete image update, on the Docker host:

```sh
docker compose pull tuxee
docker compose up -d tuxee
```

This recreates the container when the image changes, ending terminals and
rerunning startup scripts. Configured volumes retain their data; the container
account database is recreated according to the existing ROOT_PASSWORD contract.

`tuxee update` also works as root inside a writable container. It replaces
the binary. On the next server start, that binary runs its embedded
[`update.sh`](../internal/update/update.sh) to install missing release prerequisites.
Run `tuxee restart` inside the container when ready. It restarts Tuxee while
leaving the container and `/init` hooks running. That update survives restarts of
the same container; recreation uses the selected image's binary.
No binary-override volume or Docker socket access is needed.

For 0.2.1, setup installs the minimal private audio runtime in existing Tuxee
containers. It checks the system first, refreshes apt metadata before installing
any missing prerequisites, and downloads the architecture-specific audio bundle
from the binary's release tag. The release checksum and staged executables are
verified before installation. It does not install compilers, the full PulseAudio
package, or change the host's sound configuration.

New images already contain the runtime and their build version in
`/usr/local/lib/tuxee/update-version`, so **brand-new containers skip setup**,
including when reusing older data volumes. Successful upgrades advance this
marker in the container's writable layer; subsequent starts skip it. Legacy
containers without a marker run setup once. Setup takes at most five minutes;
failure is logged, the server still starts, and setup retries on the next start.
Native installations and commands such as `version` or `update --check` never
run container setup. The script stays separate in the repository and is embedded
at build time; startup does not download or execute a remote script.

## Update notices

The server checks GitHub on startup and daily at **00:01 in its local timezone**
(normally UTC in the image). A manual About → Check now uses the same
checker, with overlapping requests coalesced and at most one attempt per clock
minute across all users. The limit resets when the minute changes, so a check at
23:16:59 permits another at 23:17:00. Failed checks retain the last known release
and show an error. The displayed time records the last completed attempt.
The server keeps working when GitHub is unavailable.

Signed-in visible browsers read cached status once a minute and on focus/visibility
return. Available updates show the existing warning icon on About and the hamburger
button. Directly below the version, About shows the status, local check time and
refresh-icon Check now action in one table row. Available updates highlight that
row and display the notification icon and a selectable terminal command. The table
starts with a link to the GitHub repository above the version.
It cannot install updates or restart the server. Logout/page closure stops polling.

## GitHub repository setup

Set these under **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `DOCKERHUB_ORG` | Docker Hub organization used to log in, e.g. `agent0ai` |
| Secret | `DOCKERHUB_OAT_TOKEN` | Organization access token with **Read public repositories** and **Image Push** access to `agent0ai/tuxee` |
| Variable, optional | `DOCKERHUB_IMAGE` | Full image name; defaults to `agent0ai/tuxee` |

Create the Docker Hub repository and grant the token access. In Docker Home,
select the organization → **Identity & auth → Access tokens → Edit**. Under
**Resources → Repository**, enable **Read public repositories** for the
`golang`, `node` and `debian` base images, and grant **Image Push** on the target
repository. See [Docker's token permissions](https://docs.docker.com/security/access-tokens/organization-access-tokens/).
A successful login alone does not establish pull permission: missing public
access causes `401 Unauthorized: access token has insufficient scopes`.
After correcting token permissions, rerun the failed Actions jobs for the same
tag. Replace the GitHub secret only if the token value changed.

For a personal
access token, use its Docker Hub username as `DOCKERHUB_ORG`. No manually created
GitHub token is needed: the publishing job requests `contents: write` on the
automatic Actions token. Repository/organization policy must permit Actions and
that permission, plus the referenced GitHub and Docker actions.

If overriding the image variable, update the deployment's Compose image name too.
No OpenRouter key or release-note service is required.

Commit and push the implementation before tagging its release:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Use a new `vMAJOR.MINOR.PATCH` tag each time. Branch pushes do not publish.
Prerelease and shortened tags such as `v1.2` are rejected.

The workflow uses native `ubuntu-24.04` and `ubuntu-24.04-arm` runners. Each runs
the checks and builds the same Dockerfile: its Bookworm backend exports
`tuxee-linux-amd64` or `tuxee-linux-arm64` and provides the executable in the image.
The tag supplies `tuxee version`. The workflow tests both exported binaries, native installation/reinstallation
and image entrypoints before publication.

After both jobs pass, publication uploads the two binaries, matching
`tuxee-audio-linux-{amd64,arm64}.tar.gz` bundles and `checksums.txt`
to a draft GitHub Release named **Tuxee vX.Y.Z**. Notes contain every commit subject
and body since the previous reachable stable version tag; the first release
includes all reachable commits. It then publishes the two-platform Docker
manifest and makes the GitHub Release public. Older version releases do not
move either latest pointer backwards.

GitHub and Docker Hub cannot publish in one transaction. If publication fails,
inspect the Actions error, fix credentials/connectivity and rerun the failed job.
The job can reuse its draft and uploaded artifacts; it refuses to replace an
already published GitHub Release. A failed platform build may leave untagged
image digests on Docker Hub, but does not publish a partial multi-platform release.

Local workflow linting and fixture tests do not verify registry permissions or
native CI runners. Confirm both architecture jobs and the publishing job on the
first real tag before treating the distribution path as validated.
