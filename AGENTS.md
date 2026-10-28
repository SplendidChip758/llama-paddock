# Instructions for AI coding agents

llama-paddock is a self-hosted dashboard for monitoring and managing a fleet of Ollama hosts. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full process and [ROADMAP.md](ROADMAP.md) for where the project is going. This file is the short version, plus the rules agents most often get wrong.

## Layout

| Path | What | Notes |
|---|---|---|
| `dashboard/` | Next.js 16 + React 19 + TypeScript app: UI, JSON API under `app/api/`, background poller (`lib/server.ts`, started from `instrumentation.ts`) | Runs in Docker (`node:22-alpine`) or via `install/dashboard.sh`. Needs Node 22.13+ |
| `agent/linux/paddock-agent.mjs` | Agent on each Linux Ollama host (systemd) | Plain Node, no dependencies, Node 18.15+ |
| `agent/windows/paddock-agent.mjs` | Agent on Windows PCs (Scheduled Task) | Same HTTP API as the Linux agent. Change both together |
| `install/*.sh` | One-liner installers (Proxmox LXC or local) | Served raw from the `main` and `dev` branches, not from releases: a merged change is live immediately |
| `.github/workflows/` | `ci` (PR checks), `pr-title`, `release` (semantic-release) | |

Runtime data (hosts added in the UI, login, `paddock.db`) lives in `PADDOCK_DATA_DIR`. Files there hold secrets: write them with mode 600.

## Checks

There is no test suite. Before pushing, run what CI runs:

```bash
cd dashboard && npm ci && npm run typecheck && npm run build
node --check agent/linux/paddock-agent.mjs && node --check agent/windows/paddock-agent.mjs
for f in install/*.sh .github/scripts/*.sh; do bash -n "$f"; done
```

Dev server: `cd dashboard && PADDOCK_DATA_DIR=../data npm run dev`. For behaviour changes, also run the build against a real or fake Ollama/agent and say in the PR what you ran.

## Commit messages

Releases are fully automated: semantic-release reads every commit message on `main` and `dev` to pick the next version and write `CHANGELOG.md`. A wrong type ships a wrong version, so get this right.

**Format:** [Conventional Commits](https://www.conventionalcommits.org).

```
<type>(<scope>): <summary>

<body: what changed and why, wrapped at ~72 columns>

<footers, e.g. Closes #12>
```

- Summary: imperative mood, lowercase, no trailing period, under ~72 characters. `add GPU fan curve`, not `Added GPU fan curve.`
- Body: explain the why and anything a reviewer or user needs (new settings, upgrade notes). Bullets are fine.
- Link issues in the body or PR description with `Closes #N`.
- Every commit on a branch must be valid. PRs are usually squash-merged (the PR title becomes the commit), but `dev` → `main` and `main` → `dev` use merge commits, so branch commits reach the changelog too.

**Types** (bump while 0.x):

| Type | For | Bump |
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
| `chore` | anything else not touching shipped code | none |

Pick the type by what users see, not by the files touched. Docs-only changes to `install/` scripts' comments are `docs`; a new installer option is `feat(install)`.

**Scopes** (optional, but use one when it fits): `dashboard`, `agent`, `agent-linux`, `agent-windows`, `install`, `docker`, `ci`, `docs`.

**Breaking changes: don't mark one unless the maintainer agrees.** Adding `!` or a `BREAKING CHANGE:` footer is reserved for upgrades that need the user to do something by hand (see Versioning in ROADMAP.md): a removed or renamed config key, env var or `/api` endpoint, a data directory that can't be migrated automatically, a dashboard that can no longer talk to the previous agents. If the installer, the updater or an automatic migration handles it, it's not breaking: describe it in the body instead. 1.0.0 is cut deliberately at the end of M5 ([#34](https://github.com/SplendidChip758/llama-paddock/issues/34)). Never cause it as a side effect.

**Examples:**

```
feat(dashboard): show VRAM headroom on the model card
fix(agent-windows): restart Ollama when the tray app isn't running
perf(dashboard): poll idle instances less often
feat(install): add a prerelease installer with a disclaimer
docs: add Proxmox LXC notes
build(docker): bump base image to node:22-alpine
```

Never edit `CHANGELOG.md` or the `version` fields in `dashboard/package.json`, `package-lock.json` and the agents by hand: the release workflow writes them.

## Branches and pull requests

- Branch from `dev` and open the PR against `dev`. Merges to `dev` publish prereleases (`vX.Y.Z-dev.N`, image `:dev`). `main` is stable and only receives `dev` when it ships, plus urgent hotfixes.
- Branch names: `<type>/<short-topic>`, e.g. `feat/persistent-history`, `fix/host-editor-url`, `docs/roadmap`.
- The PR title must be a valid Conventional Commit (the `pr-title` check enforces it). Fill in `.github/pull_request_template.md`.
- One logical change per PR.
- Planned work has an issue with the `roadmap` label and a milestone. Reference it, and tick off the scope checklist in the PR description.

## Code conventions

- Match the surrounding code: its comment density, naming and idiom. Comments say why, not what.
- Dashboard server code imports `"server-only"`, except `lib/store.ts`, which `proxy.ts` imports. Route handlers wrap their bodies in `handle()` and throw `HttpError` for client errors.
- `fs` calls on runtime paths carry `/*turbopackIgnore: true*/` so the bundler doesn't try to trace them.
- Avoid new dependencies, especially native modules. The dashboard ships as a multi-arch image and a prebuilt tarball, and the agents have no dependencies at all. Prefer Node built-ins (`node:sqlite`, `fetch`, `crypto`).
- Database schema changes: append a new entry to `MIGRATIONS` in `dashboard/lib/db.ts`. Never edit one that has shipped.
- When you add a setting, env var, API endpoint or behaviour change, update the README (and `config.example.yaml` plus the config the installer writes, for settings).
- No tokens, passwords or personal hostnames/IPs in code, logs, commits or screenshots. Use the `192.168.30.x` example addresses that the docs already use.
