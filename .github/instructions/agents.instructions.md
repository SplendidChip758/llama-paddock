---
applyTo: "test/sim/**,test/agent.mjs,test/agent-release"
---

# Agents

The agents live in their own repositories, each with its own releases and rules (its AGENTS.md): the Linux agent in [llama-paddock-agent](https://github.com/SplendidChip758/llama-paddock-agent), the Windows agent in [llama-paddock-win-agent](https://github.com/SplendidChip758/llama-paddock-win-agent). Change them there; an API change needs a PR in both. This repository talks to them, simulates them, and tests against a released one.

## Rules

- **The dashboard has to keep working with older agents.** Handle a missing field, and fall back when a route answers 404. `dashboard/lib/types.ts` (`AgentStats`, `EnvState`, …) describes the agent API.
- **The agent protocol** (`dashboard/lib/protocol.ts`, docs/api.md, Agent protocol) decides which agents the dashboard uses. Raise `AGENT_PROTOCOL.max` once the dashboard has learned a new protocol, and release that before agents that speak it. Raise `min` only for a breaking change, with the maintainer's agreement.
- **Keep the simulated agent in step** (`test/sim/paddock-sim.mjs`). When an agent's API changes, change the simulator in a PR here, and say in both PRs which one to merge first. The `real-agent` scenario test compares the simulator's shapes and env rules with the real Linux agent's.
- **`test/agent-release`** names the agent release the tests run (`test/agent.mjs` downloads it and checks it against `SHA256SUMS`). Bump it when the dashboard needs a newer agent. `PADDOCK_AGENT_SRC=<clone of llama-paddock-agent>` runs the tests against an unreleased agent.

## Checks

```bash
node --check test/sim/paddock-sim.mjs && node --check test/agent.mjs
(cd dashboard && npm run build && npm run test:scenarios)
```
