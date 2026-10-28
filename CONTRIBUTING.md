# Contributing

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Commit messages

Releases are fully automated: [semantic-release](https://github.com/semantic-release/semantic-release) reads the commit messages on `main` to decide the next version and write `CHANGELOG.md`. Every commit (or PR title, when squash-merging) must follow [Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<optional scope>): <short summary>

<optional body>

<optional footer(s)>
```

- Summary in the imperative mood, lowercase, no trailing period: `add GPU fan curve`, not `Added GPU fan curve.`
- Keep the first line under ~72 characters.

### Types

| Type | Use it for | Version bump (0.x) | Version bump (≥ 1.0) | In changelog |
|---|---|---|---|---|
| `feat` | A new user-facing feature | minor | minor | ✅ Features |
| `fix` | A bug fix | patch | patch | ✅ Bug Fixes |
| `perf` | A performance improvement | patch | patch | ✅ Performance |
| `revert` | Reverting an earlier commit | patch | patch | ✅ Reverts |
| `docs` | README, docs, comments only | – | – | – |
| `refactor` | Code change with no behaviour change | – | – | – |
| `style` | Formatting, whitespace | – | – | – |
| `test` | Adding or fixing tests | – | – | – |
| `build` | Dockerfile, dependencies, `package.json` | – | – | – |
| `ci` | `.github/workflows` | – | – | – |
| `chore` | Anything else that doesn't touch shipped code | – | – | – |

### Scopes

Optional, but helps the changelog. Use the area you touched:

`dashboard`, `agent`, `agent-linux`, `agent-windows`, `install`, `docker`, `ci`, `docs`

### Breaking changes

Add `!` after the type/scope, and/or a `BREAKING CHANGE:` footer explaining what users must do:

```
feat(agent)!: require PADDOCK_AGENT_TOKEN on every request

BREAKING CHANGE: agents now reject unauthenticated requests. Set
PADDOCK_AGENT_TOKEN on each host and in config.yaml before upgrading.
```

While the project is pre-1.0 this bumps the **minor** version (`0.3.2` → `0.4.0`). See [Going to 1.0.0](#going-to-100).

### Examples

```
feat(dashboard): show VRAM headroom on the model card
fix(agent-windows): restart Ollama when the tray app isn't running
perf(dashboard): poll idle instances less often
docs: add Proxmox LXC notes
build(docker): bump base image to node:22-alpine
ci: cache npm in the release workflow
chore: tidy .gitignore
```

### Going to 1.0.0

Pre-1.0 behaviour comes from this rule in `.releaserc.json`, which turns breaking changes into minor bumps:

```json
"releaseRules": [{ "breaking": true, "release": "minor" }]
```

When the project is ready for 1.0, remove that rule in the same PR as a breaking commit, for example:

```
feat!: first stable release

BREAKING CHANGE: the config.yaml and agent APIs are now stable.
```

From then on, breaking changes bump the major version as usual.

## Branches

| Branch | Purpose | Releases |
|---|---|---|
| `dev` | Integration branch. Open feature and fix PRs against `dev`. | prereleases `vX.Y.Z-dev.N`, image `:dev` |
| `main` | Stable. Only receives `dev` once it's ready to ship (and urgent hotfixes). | `vX.Y.Z`, image `:latest` |

To ship what's on `dev`:

1. Open a PR from `dev` into `main` and merge it with **Create a merge commit**, not squash. Squashing would collapse every change into one changelog line and leave `dev` and `main` with diverging histories.
2. The release workflow on `main` publishes `vX.Y.Z` with a changelog covering everything since the last stable release.
3. Merge `main` back into `dev`: open a PR from `main` into `dev` (title e.g. `chore: merge main into dev`) and merge it with **Create a merge commit**. This brings the `chore(release)` commit and the new tag into `dev`, so the next prerelease counts up from the new version instead of reusing it.

A hotfix can go straight to `main` as a normal squash-merged PR. Merge `main` back into `dev` afterwards in the same way.

Both branches are protected by rulesets: changes go through a PR, force pushes and deletion are blocked, and the `ci` and `pr-title` checks must pass. Only the release workflow pushes directly, using the `RELEASE_DEPLOY_KEY` deploy key. `v*` tags can only be created by that key and can't be moved or deleted.

## Pull requests

- Feature and fix PRs are squash-merged, so the **PR title** becomes the commit message on `main`. The `pr-title` check fails if it isn't a valid Conventional Commit.
- The `ci` workflow typechecks and builds the dashboard and checks that the agents and shell scripts parse. Run `cd dashboard && npm run typecheck && npm run build` before pushing to catch failures early.
- One logical change per PR keeps the changelog readable.

## How a release happens

Every push to `main` or `dev` runs `.github/workflows/release.yml`. If any commit since the last tag is a `feat`, `fix`, `perf`, `revert` or breaking change, semantic-release:

1. works out the next version from those commits,
2. stamps it into `dashboard/package.json`, `dashboard/package-lock.json` and both agents, and updates `CHANGELOG.md`,
3. builds the dashboard tarball and agents into `dist/`,
4. commits the bumped files as `chore(release): x.y.z [skip ci]` and tags `vX.Y.Z`,
5. creates the GitHub release with the generated notes and the `dist/` assets.

Then the `docker-build` jobs build the image on native amd64 and arm64 runners, and the `docker` job combines them into `ghcr.io/…/llama-paddock:X.Y.Z`, `:X.Y` and `:latest`.

On `dev` the same steps produce a prerelease instead: version `X.Y.Z-dev.N`, a GitHub release marked as a prerelease, and images `:X.Y.Z-dev.N` and `:dev`. `:latest` and `:X.Y` are left alone.

If nothing releasable landed (only `docs`, `chore`, `ci` and so on), the workflow exits without releasing.
