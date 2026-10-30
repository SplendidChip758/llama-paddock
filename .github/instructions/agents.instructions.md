---
applyTo: "agent/**"
---

# Agents (`agent/linux/`, `agent/windows/`)

Each agent is one file, `paddock-agent.mjs`: plain Node ESM with **zero npm dependencies**, running on Node 18.15+. The Linux agent runs as a root systemd service. The Windows agent runs as a Scheduled Task at logon in the user's session.

## Rules

- **Keep both agents' HTTP API in step.** Same routes, same request and response shapes. The dashboard's `dashboard/lib/types.ts` (`AgentStats`, `EnvState`, …) describes them. Change all three together. Fields that only make sense on one platform are optional.
- Routes live in the `routes` table as `"METHOD /path"` handlers. Every route except `GET /health` needs `Authorization: Bearer <PADDOCK_AGENT_TOKEN>`. Keep that.
- Run external commands with an argument array, never through a shell. Use the `run()` helper (`execFile` with a timeout) for commands whose output you wait on, and `spawn(…, { detached: true })` only for starting long-running processes such as Ollama.
- Validate everything from the request before it reaches a file or a command, e.g. env var names against `KEY_RE`.
- Configuration comes from `PADDOCK_*` env vars, documented in the header comment. Add new ones there and in `docs/agent-linux.md` or `docs/agent-windows.md`.
- `PADDOCK_DRY_RUN=1` must never call `systemctl`/`journalctl` (Linux) or restart Ollama (Windows). Keep that working for new actions.
- Don't edit `VERSION`: the release workflow stamps it.
- When the API changes, change the simulated agent in `test/sim/paddock-sim.mjs` too. The `real-agent` scenario test compares its shapes and env rules with the Linux agent's.
- The dashboard has to keep working with older agents. Add fields and routes instead of changing existing ones, and have the dashboard handle a missing field.

## Checks

```bash
node --check agent/linux/paddock-agent.mjs && node --check agent/windows/paddock-agent.mjs
```

Run an agent locally with `PADDOCK_AGENT_TOKEN=test PADDOCK_DRY_RUN=1 node agent/linux/paddock-agent.mjs`, then call it with `curl -H "Authorization: Bearer test" localhost:11435/stats`.
