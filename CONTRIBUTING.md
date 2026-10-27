# Contributing

## Commit messages

Releases are fully automated: [release-please](https://github.com/googleapis/release-please) reads the commit messages on `main` to decide the next version and write `CHANGELOG.md`. Every commit (or PR title, when squash-merging) must follow [Conventional Commits](https://www.conventionalcommits.org):

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

While the project is pre-1.0 this bumps the **minor** version (`0.3.2` → `0.4.0`); from `1.0.0` on it bumps the **major** version.

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

### Forcing a specific version

To cut a particular version (for example the first stable release), put this footer in the body of a commit on `main`:

```
chore: release 1.0.0

Release-As: 1.0.0
```

## Pull requests

- PRs are squash-merged, so the **PR title** becomes the commit message on `main`. The `pr-title` check fails if it isn't a valid Conventional Commit.
- One logical change per PR keeps the changelog readable.

## How a release happens

1. Conventional commits land on `main`.
2. release-please keeps a `chore(main): release x.y.z` PR open with the version bumps and changelog.
3. Merging that PR tags `vX.Y.Z`, creates the GitHub release, and runs `release.yml` to attach the build artifacts and publish the container image.
