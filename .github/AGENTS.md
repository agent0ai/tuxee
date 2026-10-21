Parent DOX: [project](../AGENTS.md).

# Purpose

Tag-triggered binary and Docker Hub releases, and repository presentation assets.

# Ownership

Own Actions workflows and release-note generation. Root owns Dockerfile and
installer; internal/update owns the release-asset contract.
`resources/` owns optimized README screenshots, infographics and their thumbnails.

# Local Contracts

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
- Require `DOCKERHUB_ORG` and `DOCKERHUB_OAT_TOKEN` secrets. Optional repository
  variable `DOCKERHUB_IMAGE` defaults to `agent0ai/tuxee`. The token needs
  Read public repositories for base-image pulls and Image Push on the target
  repository. Login success does not verify those scopes. Use the job-scoped
  GitHub token with contents:write only in the publishing job.

# Work Guidance

No branch/nightly publication or external release-note generator.

# Verification

`python3 .github/release-notes.py --self-test`; validate workflow syntax with
actionlint. Native CI builds/tests and registry publication require GitHub Actions.

# Child DOX Index

- [resources/AGENTS.md](resources/AGENTS.md): Optimized screenshots, infographics and thumbnails linked from the README.
