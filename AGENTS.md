# Instructions for AI coding agents

llama-paddock is a self-hosted dashboard for monitoring and managing a fleet of Ollama hosts. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full process and [ROADMAP.md](ROADMAP.md) for where the project is going. This file is the short version, plus the rules agents most often get wrong.

## Layout

| Path | What | Notes |
|---|---|---|
| `dashboard/` | Next.js 16 + React 19 + TypeScript app: UI, JSON API under `app/api/`, background poller (`lib/server.ts`, started from `instrumentation.ts`) | Runs in Docker (`node:22-alpine`) or via `install/dashboard.sh`. Needs Node 22.13+ |
| `agent/linux/paddock-agent.mjs` | Agent on each Linux Ollama host (systemd) | Plain Node, no dependencies, Node 18.15+ |
| `agent/windows/paddock-agent.mjs` | Agent on Windows PCs (Scheduled Task) | Same HTTP API as the Linux agent. Change both together |
| `install/*.sh` | One-liner installers (Proxmox LXC or local) | Served raw from the `main` and `dev` branches, not from releases: a merged change is live immediately |
| `docs/` | User documentation, also built into the website's Docs section | Plain GitHub Markdown: each page starts with one `# Title` and links to other pages with relative `.md` paths. `docs/README.md` is the index and sets the website's sidebar |
| `test/` | `sim/paddock-sim.mjs` (simulated Ollama hosts and agents) and `scenarios/` (`node:test` behaviour tests run in CI) | Plain Node, no dependencies |
| `.github/workflows/` | `ci` (PR checks), `pr-title`, `release` (semantic-release) | |

Runtime data (hosts added in the UI, login, `paddock.db`) lives in `PADDOCK_DATA_DIR`. Files there hold secrets: write them with mode 600.

## Checks

Before pushing, run what CI runs:

```bash
(cd dashboard && npm ci && npm run typecheck && npm run build && npm run test:scenarios)
node --check agent/linux/paddock-agent.mjs && node --check agent/windows/paddock-agent.mjs
for f in install/*.sh .github/scripts/*.sh; do bash -n "$f"; done
```

`test:scenarios` runs `test/scenarios/` with `node:test`: the built dashboard against simulated Ollama hosts and agents (`test/sim/paddock-sim.mjs`, no dependencies). For behaviour changes, add or extend a scenario there, and say in the PR what you ran.

Dev server: `cd dashboard && PADDOCK_DATA_DIR=../data npm run dev`. Without a real Ollama host, run the simulator (CONTRIBUTING.md, Simulated hosts).

## Commit messages

Releases are fully automated: semantic-release reads every commit message to pick the next version, so a wrong type ships a wrong version. **Read [.github/instructions/commit-message.instructions.md](.github/instructions/commit-message.instructions.md) before committing.** In short:

- Conventional Commits: `<type>(<scope>): <summary>`, an imperative lowercase summary, and a body that says why.
- `feat` bumps the minor version and `fix`/`perf` the patch version. `docs`, `chore`, `ci`, `build`, `refactor` don't release.
- **Never mark a change as breaking (`!`, `BREAKING CHANGE:`) unless the maintainer agrees.** 1.0.0 is cut deliberately, never as a side effect.
- Never edit `CHANGELOG.md` or version fields by hand.

## Branches and pull requests

- Branch from `dev` and open the PR against `dev`. Merges to `dev` publish prereleases (`vX.Y.Z-dev.N`, image `:dev`). `main` is stable and only receives `dev` when it ships, plus urgent hotfixes (branched from `main`).
- PRs into `dev` are squash-merged and PRs into `main` get a merge commit. The rulesets enforce both. The release workflow merges `main` back into `dev` after a stable release, so never open that PR yourself.
- Don't open a PR per small change. Batch changes when only one needs a changelog line, and split them when each deserves its own (see CONTRIBUTING.md, Pull requests).
- Branch names: `<type>/<short-topic>`, e.g. `feat/persistent-history`, `fix/host-editor-url`, `docs/roadmap`.
- The title and description rules are in [.github/instructions/pull-request.instructions.md](.github/instructions/pull-request.instructions.md).

## Issues and the roadmap project

Planned work has an issue (label `roadmap`, a milestone) and an item on the **llama-paddock roadmap** project (user project #6 of `SplendidChip758`). Its Status moves through:

| Status | Means |
|---|---|
| `Todo` | not started |
| `In Progress` | being worked on, on a branch |
| `In Review` | PR open, or merged to `dev` and being tested in a prerelease |
| `Done` | merged to `main`, so in a stable release. Set automatically when the issue closes |

Keep the issue, its branch and its PR connected:

1. **Start from the issue**, so the branch is linked and its PR shows under the issue's Development section:
   ```bash
   gh issue develop <n> --base dev --name <type>/<topic> --checkout
   ```
   Closing keywords in a PR only link it when the PR targets the default branch (`main`). Feature PRs target `dev`, so the linked branch is what connects them.
2. **Set the project Status to `In Progress`** (`gh project item-edit`, project #6) when you start, and to **`In Review`** when you open the PR.
3. **Put `Closes #<n>` in the commit body** and in the PR description. The commit carries it to `main`: when `dev` is merged to `main`, GitHub closes the issue and the project moves it to `Done`. A hotfix PR straight into `main` closes it on merge. Don't set `Done` by hand: the project's auto-close workflow would close the issue before the change is on `main`.
4. **After the PR merges to `dev`:** tick the finished items in the issue's scope checklist, note anything left over, and leave the issue open and `In Review` until it reaches `main`.

### The website shows the roadmap

The website's roadmap page is built from these issues and the project: each milestone, its items, their Status and progress bars. It rebuilds on issue changes and every 6 hours, so a stale Status is a wrong public roadmap.

- **Every roadmap issue is on project #6**, with the `roadmap` label and a milestone. An issue that isn't on the project doesn't appear on the site.
- **Keep Status current**, as above: `In Progress` when you start, `In Review` when the PR opens. Never leave finished work at `Todo`.
- **Titles are shown as they are:** short and user-facing, no type prefix (`Long-range metric charts`, not `feat: long-range charts`).
- **New planned work:** create the issue and add it to the project, then set its Status. Add a bullet to the milestone's section in ROADMAP.md if users would look for the feature.
  ```bash
  gh issue create --label enhancement,roadmap --milestone "M5: Updates (→ 1.0)" --title "<title>" --body-file <file>
  gh project item-add 6 --owner SplendidChip758 --url <issue URL>
  ```
- **Setting Status by command** (these IDs don't change):
  ```bash
  item=$(gh project item-list 6 --owner SplendidChip758 --format json --limit 200 \
    --jq '.items[] | select(.content.number == <n>) | .id')
  gh project item-edit --project-id PVT_kwHOAOmHZM4BpBVK --id "$item" \
    --field-id PVTSSF_lAHOAOmHZM4BpBVKzhnex1c --single-select-option-id <option>
  # options: Todo f75ad846 · In Progress 47fc9ee4 · In Review 84dbe197 (Done is set by closing the issue)
  ```
- **The site parses ROADMAP.md**, so keep its formats:
  - the milestone table, one row per milestone in order: `| M5 | [Updates](#m5-updates--10) | Theme | Version |`
  - one `## M5: Name` section per milestone (and `## Later`), with features as `- **Name.** text` and a `**Done when:** …` line
  - GitHub milestone titles start with the same code (`M5: …`), or are exactly `Later`. A new milestone needs all three: the GitHub milestone, the table row and the section.

Small fixes and docs don't need an issue.

## Code conventions

- Match the surrounding code: its comment density, naming and idiom. Comments say why, not what.
- Avoid new dependencies, especially native modules. Prefer Node built-ins.
- When you add a setting, env var, API endpoint or behaviour change, update the matching page in `docs/` (the website's Docs section is built from it). New pages go in the `docs/README.md` index.
- No tokens, passwords or personal hostnames/IPs in code, logs, commits or screenshots. Use the `192.168.30.x` example addresses that the docs already use.

Each area has its own rules. **Read the file for the area you're changing:**

| Area | Rules |
|---|---|
| `dashboard/` | [.github/instructions/dashboard.instructions.md](.github/instructions/dashboard.instructions.md) |
| `agent/` | [.github/instructions/agents.instructions.md](.github/instructions/agents.instructions.md) |
| `install/` | [.github/instructions/install.instructions.md](.github/instructions/install.instructions.md) |

GitHub Copilot applies these automatically by path (`applyTo`). `.vscode/settings.json` points Copilot's commit message and PR description generators at the matching files.
