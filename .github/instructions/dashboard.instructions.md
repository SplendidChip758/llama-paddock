---
applyTo: "dashboard/**"
---

# Dashboard (`dashboard/`)

Next.js 16 (App Router) + React 19 + TypeScript, built with `output: "standalone"`. It ships as a multi-arch Docker image (`node:22-alpine`) and as a prebuilt tarball that `install/dashboard.sh` runs on the host's Node. It needs Node 22.13+.

## Structure

- `lib/server.ts`: per-process state on `globalThis.__paddock` (instances, jobs), the background poller, and the upstream calls to Ollama (`ollama()`) and agents (`agent()`). The poller starts from `instrumentation.ts`.
- `lib/config.ts`: `config.yaml` (optional, `${VAR}` expansion) and the hosts added in the UI (`hosts.json`). Settings and their defaults live in `loadSettings()`.
- `lib/store.ts`: small JSON files in `PADDOCK_DATA_DIR`. `lib/db.ts`: SQLite (`node:sqlite`) for metric history and jobs.
- `lib/types.ts`: shapes shared by the server and the browser, including the agent's `/stats` response. Keep it in step with the agents.
- `app/api/**/route.ts`: the JSON API. `components/`: client components.

## Rules

- Server modules import `"server-only"`, except `lib/store.ts` (`proxy.ts` imports it through `lib/auth.ts`).
- Route handlers export `dynamic = "force-dynamic"`, wrap their body in `handle()`, and throw `HttpError(status, message)` for client errors. Responses go through `json()`, with errors as `{ detail }`.
- `fs` calls on runtime paths carry `/*turbopackIgnore: true*/` so the bundler doesn't try to trace them.
- Files in the data directory can hold secrets: create them with mode 600 (and directories 700). Never return a stored token or key to the browser.
- No new dependencies without a good reason, and no native modules: they break the multi-arch image and the tarball. Prefer Node built-ins.
- Schema changes: append a new entry to `MIGRATIONS` in `lib/db.ts`. Never edit one that has shipped. Existing databases upgrade on start.
- Keep `/api` backwards compatible. Add optional parameters and fields instead of changing what existing ones mean, since users script against it.
- New settings go in `loadSettings()` with a default, `config.example.yaml`, the config written by `install/dashboard.sh`, and `docs/configuration.md`. New endpoints go in the API tables in `docs/api.md`.
- Match the surrounding style: section headers like `// ===== poller`, short comments that explain why.

## Checks

```bash
npm run typecheck && npm run build
```

Then `npm run test:scenarios`: the scenario tests in `test/scenarios/` run the standalone build against the simulator (`test/sim/paddock-sim.mjs`). When you change how the dashboard reacts to hosts, jobs or credentials, add or extend a scenario there.

Dev server: `PADDOCK_DATA_DIR=../data npm run dev`, against a real Ollama host or the simulator (CONTRIBUTING.md, Simulated hosts).
