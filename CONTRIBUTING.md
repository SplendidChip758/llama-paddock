# Contributing

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Local development

Use Node.js 22.13 or newer. From a clone of the repository:

```bash
cd dashboard
npm ci
PADDOCK_DATA_DIR="$PWD/../data" npm run dev
```

Open `http://localhost:8080`. The initial login is printed in the terminal unless you set `PADDOCK_PASSWORD`. Add a real or fake Ollama host when checking behavior. For deployment instructions, see the [documentation](docs/README.md); for source layout, see [Architecture](docs/architecture.md).

There is no automated test suite. Before pushing, run the same checks as CI from the repository root:

```bash
(cd dashboard && npm ci && npm run typecheck && npm run build)
node --check agent/linux/paddock-agent.mjs
node --check agent/windows/paddock-agent.mjs
for f in install/*.sh .github/scripts/*.sh; do bash -n "$f"; done
```

For behavior changes, also exercise the built dashboard against a real or fake Ollama/agent and describe what you ran in the PR. Keep the Linux and Windows agent APIs aligned. Update the relevant documentation and README entry points when adding settings, endpoints or behavior.

Read [AGENTS.md](AGENTS.md) and the area-specific rules it links before changing code. Never commit runtime data, tokens, passwords or private host details.

## Start a change

Branch from `dev`, using `<type>/<short-topic>` (for example `docs/setup-guide`). Small fixes and docs changes do not need an issue.

For planned roadmap work, start from its issue so GitHub links the branch and PR:

```bash
# Replace 123 with the roadmap issue number.
gh issue develop 123 --base dev --name feat/short-topic --checkout
```

On the **llama-paddock roadmap** project (user project #6 of `SplendidChip758`), move the item to **In Progress** when work starts and **In Review** when the PR opens. Put `Closes #<number>` in both the commit body and PR description. Because feature PRs target `dev`, the linked branch connects the work to the issue; the closing keyword reaches `main` with the release.

After merging to `dev`, tick completed scope items in the issue and note anything left over. Keep the issue open and **In Review** until it reaches `main`; closing the issue moves it to **Done** automatically. Do not set Done manually.

## Commit messages

Releases are fully automated: [semantic-release](https://github.com/semantic-release/semantic-release) reads the commit messages on `main` and `dev` to decide the next version and write `CHANGELOG.md`. Every commit (or PR title, when squash-merging) must follow [Conventional Commits](https://www.conventionalcommits.org):

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

**Only mark a change as breaking after the maintainer agrees.** Never edit `CHANGELOG.md` or version fields by hand; the release workflow owns them.

For an agreed breaking change, add `!` after the type/scope, and/or a `BREAKING CHANGE:` footer explaining what users must do:

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

Each branch accepts one merge method, enforced by its ruleset:

| PR | Merge method | Why |
|---|---|---|
| feature/fix branch → `dev` | **Squash** | The PR title becomes the one commit semantic-release reads, so work-in-progress commits never reach the changelog. |
| `dev` → `main` | **Merge commit** | semantic-release on `main` needs every change's commit. Squashing would collapse a release into one changelog line and leave `dev` and `main` with diverging histories. |

To ship what's on `dev`:

1. Open a PR from `dev` into `main` and merge it (merge commit).
2. The release workflow on `main` publishes `vX.Y.Z` with a changelog covering everything since the last stable release.
3. The same workflow then merges `main` back into `dev` (the `backmerge` job). This brings the `chore(release)` commit and the new tag into `dev`, so the next prerelease counts up from the new version instead of reusing it. If that merge conflicts, the job fails and opens a PR from a `backmerge/vX.Y.Z` branch instead. Its description explains how to resolve and merge it.

**Hotfixes:** branch from `main`, open the PR into `main` and merge it (merge commit). Since every commit then reaches the changelog, the `commits` check makes sure each one is a Conventional Commit. The release workflow merges the fix back into `dev`.

Both branches are protected by rulesets: changes go through a PR, force pushes and deletion are blocked, and the `ci` and `pr-title` checks must pass. Only the release workflow pushes directly, using the `RELEASE_DEPLOY_KEY` deploy key. `v*` tags can only be created by that key and can't be moved or deleted.

Dependabot opens its PRs against `dev`, like everyone else.

## Pull requests

- Feature and fix PRs are squash-merged, so the **PR title** becomes the commit message on `main`. The `pr-title` check fails if it isn't a valid Conventional Commit.
- Fill in the [PR template](.github/pull_request_template.md) and follow the [title and description rules](.github/instructions/pull-request.instructions.md).
- The `ci` workflow runs the [checks above](#local-development). On PRs into `main` it also checks every commit message.
- **What goes in one PR:** the squashed PR gets a single changelog line, so batch small changes when only one of them needs that line (a fix plus the README tweak that goes with it, a few docs edits). Split them when each deserves its own line or a different version bump (a `feat` and an unrelated `fix`), or when one is big or risky enough that you'd want to revert it on its own.

## How a release happens

Pushes to `main` or `dev` that change dashboard/agent code or release configuration run `.github/workflows/release.yml`; it can also be started manually. Docs-only changes do not trigger it. Installer scripts are served directly from their branch, so merging an installer change makes it live immediately without a release. If any commit since the last tag is a `feat`, `fix`, `perf`, `revert` or breaking change, semantic-release:

1. works out the next version from those commits,
2. stamps it into `dashboard/package.json`, `dashboard/package-lock.json` and both agents, and updates `CHANGELOG.md`,
3. builds the dashboard tarball and agents into `dist/`,
4. commits the bumped files as `chore(release): x.y.z [skip ci]` and tags `vX.Y.Z`,
5. creates the GitHub release with the generated notes and the `dist/` assets.

Then the `docker-build` jobs build the image on native amd64 and arm64 runners, and the `docker` job combines them into `ghcr.io/…/llama-paddock:X.Y.Z`, `:X.Y` and `:latest`.

On `dev` the same steps produce a prerelease instead: version `X.Y.Z-dev.N`, a GitHub release marked as a prerelease, and images `:X.Y.Z-dev.N` and `:dev`. `:latest` and `:X.Y` are left alone.

If nothing releasable landed (only `docs`, `chore`, `ci` and so on), the workflow exits without releasing.

Release assets include `llama-paddock-dashboard-vX.Y.Z.tar.gz`, both agent scripts and `SHA256SUMS`. Runtime dependency and base-image updates from Dependabot use `fix(deps): …` so they ship in patch releases.
