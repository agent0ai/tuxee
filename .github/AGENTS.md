Parent DOX: [project](../AGENTS.md).

# Purpose

Tag-triggered releases, daily stable Docker image rebuilds, repository sponsorship and presentation assets.

# Ownership

Own Actions workflows, release-note generation and `FUNDING.yml`. Root owns Dockerfile and
installer; internal/update owns the release-asset contract.
`resources/` owns optimized README screenshots, infographics and their thumbnails.

# Local Contracts

- `FUNDING.yml` uses Agent Zero's sponsorship configuration (`github: agent0ai`).
- Push `vMAJOR.MINOR.PATCH` to release. Build on native amd64/arm64 runners.
  Docker's Bookworm backend builds both the image and exported binary, with the
  tag injected into `main.version`. Never publish unversioned development builds.
- Both architectures and checks must pass before publishing. Upload both binaries,
  `tuxee-audio-linux-{amd64,arm64}.tar.gz` and SHA-256 sums to a draft, then publish Docker manifests and the release.
  Publication across GitHub and Docker Hub is not transactional; failed drafts
  can be retried. Never overwrite a published GitHub release.
- Native installer smoke tests prepare `/usr/local/bin` as root:root with mode
  0755 on disposable runners; hosted images make it world-writable. Keep the
  installer's unsafe-directory rejection intact.
- Export audio archives from Docker's `audio-runtime` target; verify their wrappers inside the matching image and its baked setup marker. Run startup/script fixtures in disposable chroots before publication; never install test runtime packages on the CI host.
- Release title is `Tuxee <tag>`. Notes include every commit subject/body since
  the previous reachable stable version tag, or all commits for the first tag.
- Docker tags are `<tag>`, `<version>` and `latest` only for the newest stable
  release. Older releases must not move latest backwards.
- `nightly.yml` runs daily at 03:17 UTC and on manual dispatch. Resolve GitHub's
  latest published stable release tag to one commit for both native architectures.
  Pull fresh bases, disable build caches and append a final Debian package upgrade
  to the released Dockerfile in the runner's temporary directory. Preserve pinned
  dependencies and the application version; dependency bumps remain manual.
  Verify version/setup marker, package consistency, GUI/audio executables, HTTP
  readiness, PAM login and PTY creation before refreshing the three existing tags.
  Create no dated/nightly tags or GitHub releases; leave published assets intact.
  Share the `tuxee-release` concurrency group with releases, and recheck the latest
  release before publication so an obsolete rebuild cannot move tags backwards.
- Require `DOCKERHUB_ORG` and `DOCKERHUB_OAT_TOKEN` secrets. Optional repository
  variable `DOCKERHUB_IMAGE` defaults to `agent0ai/tuxee`. The token needs
  Read public repositories for base-image pulls and Image Push on the target
  repository. Login success does not verify those scopes. Use the job-scoped
  GitHub token with contents:write only in the publishing job.

# Work Guidance

No development-branch publication or external release-note generator.

# Verification

`python3 .github/release-notes.py --self-test`; validate both workflows with
actionlint. The nightly workflow embeds runtime smoke checks; full native builds
on both architectures and registry publication require GitHub Actions.

# Child DOX Index

- [resources/AGENTS.md](resources/AGENTS.md): Optimized screenshots, infographics and thumbnails linked from the README.
