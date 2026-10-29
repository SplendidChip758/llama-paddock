# Releases

Versions follow [SemVer](https://semver.org) and are released automatically by [semantic-release](https://github.com/semantic-release/semantic-release) from [Conventional Commits](https://www.conventionalcommits.org). See [CONTRIBUTING.md](../../CONTRIBUTING.md) for how to prefix commit messages.

| Commit / PR title | Bump while `0.x` |
|---|---|
| `fix: …`, `perf: …` | patch (`0.1.0` → `0.1.1`) |
| `feat: …` | minor (`0.1.0` → `0.2.0`) |
| `feat!: …` or a `BREAKING CHANGE:` footer | minor (`0.1.0` → `0.2.0`) |
| `chore:`, `docs:`, `ci:`, `refactor:`, `test:` … | none |

Every push to `main` or `dev` runs `.github/workflows/release.yml`. When there's something to release, it:
- bumps the version in `dashboard/package.json` and both agents, updates `CHANGELOG.md`, and tags `vX.Y.Z`,
- builds the dashboard once and attaches `llama-paddock-dashboard-vX.Y.Z.tar.gz` to the GitHub release (the one-line installer downloads this),
- attaches both agents and a `SHA256SUMS` file,
- builds the image natively on amd64 and arm64 runners and pushes it as one multi-arch tag.

| Branch | Version | GitHub release | Image tags |
|---|---|---|---|
| `main` | `vX.Y.Z` | release | `:X.Y.Z`, `:X.Y`, `:latest` |
| `dev` | `vX.Y.Z-dev.N` | prerelease | `:X.Y.Z-dev.N`, `:dev` |

Prereleases are never picked up by `latest`: the installer and the `:latest` image only follow `main`. To try one, use `PADDOCK_VERSION=vX.Y.Z-dev.N` with the installer or the `:dev` image.

The workflow only runs when `dashboard/`, `agent/` or the release config change, so docs-only pushes never build an image or cut a release. Dependabot (`.github/dependabot.yml`) opens weekly update PRs; runtime dependency and base-image bumps are titled `fix(deps): …` and ship as a patch release once merged.

Configuration lives in `.releaserc.json`. PR titles are checked by `.github/workflows/pr-title.yml`, since the squash-merge commit is what semantic-release reads.
