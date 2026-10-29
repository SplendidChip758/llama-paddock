---
description: "How to write commit messages: Conventional Commits, read by semantic-release to version and release llama-paddock"
---

# Commit messages

Releases are fully automated: semantic-release reads every commit message on `main` and `dev` to pick the next version and write `CHANGELOG.md`. A wrong type ships a wrong version.

## Format

[Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<scope>): <summary>

<body: what changed and why, wrapped at ~72 columns>

<footers, e.g. Closes #12>
```

- Summary: imperative mood, lowercase, no trailing period, under ~72 characters. `add GPU fan curve`, not `Added GPU fan curve.`
- Body: explain why, plus anything a reviewer or user needs (new settings, upgrade notes). Bullets are fine. Leave it out for trivial changes.
- Link the issue with `Closes #N` in the body. PRs target `dev`, where closing keywords in the PR don't link or close anything; the keyword in the commit is what closes the issue once `dev` is merged to `main`.
- Every commit must be valid, not only the PR title. PRs into `dev` are squash-merged, but PRs into `main` (the `dev` promotion and hotfixes) get a merge commit, so their commits reach the changelog as they are. CI checks every commit in PRs into `main`.

## Types

| Type | For | Bump while 0.x |
|---|---|---|
| `feat` | a new user-facing feature | minor |
| `fix` | a bug fix | patch |
| `perf` | a performance improvement | patch |
| `revert` | reverting an earlier commit | patch |
| `docs` | README, docs, comments only | none |
| `refactor` | code change with no behaviour change | none |
| `style` | formatting, whitespace | none |
| `test` | tests | none |
| `build` | Dockerfile, dependencies, `package.json` | none |
| `ci` | `.github/workflows` | none |
| `chore` | anything else that doesn't touch shipped code | none |

Pick the type by what users notice, not by which files changed. A new installer option is `feat(install)`; a comment fix in an installer is `docs`.

## Scopes

Optional, but use one when it fits: `dashboard`, `agent`, `agent-linux`, `agent-windows`, `install`, `docker`, `ci`, `docs`.

## Breaking changes

**Don't mark a change as breaking (`!` or a `BREAKING CHANGE:` footer) unless the maintainer has agreed to it.**

Breaking is reserved for upgrades that need the user to do something by hand:
- a config key, env var or `/api` endpoint is removed or changes meaning
- the data directory can't be migrated automatically
- the dashboard can no longer talk to the previous agents

If the installer, the updater or an automatic migration handles the change, it isn't breaking: put upgrade notes in the body instead. 1.0.0 is cut deliberately at the end of milestone M5 (issue #34), never as a side effect of a commit.

## Never

- Never edit `CHANGELOG.md` or the `version` fields (`dashboard/package.json`, `package-lock.json`, the agents' `VERSION`). The release workflow writes them.
- Never put tokens, passwords or personal hostnames/IPs in a commit message.

## Examples

```
feat(dashboard): show VRAM headroom on the model card
fix(agent-windows): restart Ollama when the tray app isn't running
perf(dashboard): poll idle instances less often
feat(install): add a prerelease installer with a disclaimer
docs: add Proxmox LXC notes
build(docker): bump base image to node:22-alpine
ci: cache npm in the release workflow
```
