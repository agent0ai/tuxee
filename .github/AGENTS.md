Parent DOX: [project](../AGENTS.md).

# Purpose

Tag-triggered binary and Docker Hub releases.

# Ownership

Own Actions workflows and release-note generation. Root owns Dockerfile and
installer; internal/update owns the release-asset contract.

# Local Contracts

- Push `vMAJOR.MINOR.PATCH` to release. Build on native amd64/arm64 runners.
  Docker's Bookworm backend builds both the image and exported binary, with the
  tag injected into `main.version`. Never publish unversioned development builds.
- Both architectures and checks must pass before publishing. Upload both binaries
  and SHA-256 sums to a draft, then publish Docker manifests and the release.
  Publication across GitHub and Docker Hub is not transactional; failed drafts
  can be retried. Never overwrite a published GitHub release.
- Release title is `Tuxee <tag>`. Notes include every commit subject/body since
  the previous reachable stable version tag, or all commits for the first tag.
- Docker tags are `<tag>`, `<version>` and `latest` only for the newest stable
  release. Older releases must not move latest backwards.
- Require `DOCKERHUB_ORG` and `DOCKERHUB_OAT_TOKEN` secrets. Optional repository
  variable `DOCKERHUB_IMAGE` defaults to `agent0ai/tuxee`. Use the job-scoped
  GitHub token with contents:write only in the publishing job.

# Work Guidance

No branch/nightly publication or external release-note generator.

# Verification

`python3 .github/release-notes.py --self-test`; validate workflow syntax with
actionlint. Native CI builds/tests and registry publication require GitHub Actions.

# Child DOX Index

No children.
