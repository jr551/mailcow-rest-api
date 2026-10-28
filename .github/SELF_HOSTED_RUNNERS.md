# Self-hosted GitHub Actions runners

GitHub-hosted runners are not used for this repository (billing). Jobs use
`runs-on: self-hosted` so work is picked up by **repository** runners such as
**alexpc** and **matthewpc** when those machines are online and registered.

## Security (public repository)

Workflows skip jobs for **pull requests from forks** (`head.repo` must match
this repository). That keeps untrusted fork code off home PCs. Same-repository
PRs and pushes to `master` still run on self-hosted hardware.

## Operator checklist

1. In GitHub: **Settings → Actions → Runners** — confirm **alexpc** /
   **matthewpc** (or other labels) are registered and idle.
2. Each runner needs **Node.js 24** (or let `setup-node` install it), **npm**,
   and for `publish-image` **Docker** with permission to build `linux/amd64`.
3. Windows runners should use the GitHub Actions runner application (includes
   Git Bash); workflows set `shell: bash` for consistent scripts.

## Verifying labels

Runner names appear as labels (e.g. `alexpc`). This repo intentionally uses
the generic `self-hosted` label so either home machine can take any job. To
pin a job to one PC, set e.g. `runs-on: [self-hosted, alexpc]` once the label
is visible in the runner settings UI.
