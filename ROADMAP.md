# Roadmap

Where llama-paddock is headed, grouped into milestones. Each milestone has a **done when** line: the point where it counts as finished.

Progress is tracked in [GitHub milestones](https://github.com/SplendidChip758/llama-paddock/milestones) and their issues. This file is the overview, and the issues hold the details. Ideas and feedback are welcome: open a [feature request](https://github.com/SplendidChip758/llama-paddock/issues/new?template=feature_request.md).

llama-paddock is the control plane for inference hardware you own. Gateways route requests but can't see the GPU; cluster platforms see the GPU but want to own the whole machine. llama-paddock sits between: a one-line installer, a small agent on each host, and a dashboard that knows what every GPU is doing and what every model actually achieves on your tasks. Each feature below earns its place by using one of those two things.

| | Milestone | Theme | Version |
|---|---|---|---|
| M1 | [Foundations](#m1-foundations) | Reliable history, secure connections, automated checks, Grafana | 0.x |
| M2 | [Model workbench](#m2-model-workbench) | Find, size, create and benchmark models | 0.x |
| M3 | [Alerts & diagnostics](#m3-alerts--diagnostics) | Find out when something breaks, and why | 0.x |
| M4 | [Access & displays](#m4-access--displays) | Users, scoped tokens, audit log, accessibility and themes | 0.x |
| M5 | [Updates](#m5-updates--10) | Tested upgrades, backup and recovery | ends with **1.0** |
| M6 | [Platforms](#m6-platforms) | Agent platforms, local inference backends, GPU topology, shared PCs | 1.x |
| M7 | [Routing gateway](#m7-routing-gateway) | Transparent fleet gateway, providers and optimization | core 1.x; see Versioning |
| M8 | [Fleet operations](#m8-fleet-operations) | Run many hosts as one, including their power and Ollama versions | 1.x |
| M9 | [Hardware-aware routing](#m9-hardware-aware-routing) | Route on real GPU state, cost and measured quality; learn from outcomes | 1.x; cloud tiers follow M7 providers |
| M10 | [Managed runtimes](#m10-managed-runtimes) | Start, configure and stop runtimes from the dashboard, single-host multi-GPU | 1.x, optional |
| M11 | [Model quality lab](#m11-model-quality-lab) | Test and tune models on your own tasks; builds on M2 | 1.x |
| M12 | [Advanced diagnostics](#m12-advanced-diagnostics) | Hardware health, request explanations, SLOs, advisor cards; builds on M3 | 1.x |
| M13 | [Displays](#m13-displays) | Wall display and installable PWA; builds on M4 | 1.x |
| | [Later](#later) | Ideas awaiting a milestone | Unscheduled |

This is the milestone scope, not a list of features already available. Some items may already be implemented on `dev` or in a release; use the linked issues and milestones for status, and the [user guides](docs/README.md) for current behavior.

## Versioning

Versions are cut by semantic-release from commit messages, so a milestone usually ships across several releases. A version number isn't a milestone reward. It tells users what an upgrade will cost them.

- **0.x (now).** Anything may change. Breaking changes only bump the minor version.
- **1.0** follows the M5 core and the release checklist below. It promises that supported stable upgrades within 1.x preserve configuration, data and API compatibility without hand-editing files or repairing migrations. Starting an update, running the documented Docker update command, or approving an update is still a normal operator action.
- **1.0 finishes every 0.x milestone.** M1 to M5 are complete when 1.0 ships; nothing in them is deferred. Work that builds on them afterwards has its own milestone: M11 builds on the M2 workbench, M12 on M3 diagnostics, M13 on M4 access, and Ollama updates are part of M8 fleet operations.
- **After 1.0**, new features are minor releases, however big they are. Platforms (M6), the gateway (M7), fleet operations (M8), routing (M9), managed runtimes (M10), the quality lab (M11), advanced diagnostics (M12) and displays (M13) are additions, so they ship as 1.x. They don't depend on each other in a strict order, so work on them can overlap.
- **The major version goes up (2.0, 3.0, …)** when an upgrade breaks the supported compatibility contract, for example:
  - the dashboard can no longer talk to agents from the previous major, and they can't update themselves
  - a config key, env var or `/api` endpoint is removed or changes meaning
  - the data directory can't be migrated automatically
  - a platform or the minimum Node.js version is dropped
- **A likely 2.0:** routing to other providers (see [M7](#m7-routing-gateway)). If "hosts" become general "providers" in the config and API, that change would be breaking. Prefer adding remote providers alongside hosts so it doesn't. M9's cloud tiers inherit whatever #27 decides; M9's local scope is additive 1.x.

### What 1.0.0 contains

1.0.0 is a promise about upgrades, not a feature count. It ships when the items below are done and the checklist passes. Nothing is added to this list from here on; new ideas go to 1.x.

**Already shipped in 0.9 and counted toward 1.0.0:** persistent history and events, agent TLS and Ollama proxy keys, Prometheus endpoint, version display, long-range charts (M1); library browsing, model create and copy, fit estimates, test prompt panel, saved benchmarks, fits-on-GPU filter (M2); alert rules, channels, history and uptime, GPU check, context and reload warnings, request log, security checks (M3 core); users and roles, scoped API tokens, audit log (M4 core).

**Still open and required for 1.0.0:**

| Issue | What | Why it gates |
|---|---|---|
| [#82](https://github.com/SplendidChip758/llama-paddock/issues/82) | Simulated host and agent in CI | Every later gate check runs on it |
| [#59](https://github.com/SplendidChip758/llama-paddock/issues/59) | Agents in their own repository with a protocol version and independent releases | Agent updates pull from its releases |
| [#18](https://github.com/SplendidChip758/llama-paddock/issues/18) | Windows agent as a real Windows service (base), replacing the scheduled task | A supported Windows install the upgrade promise can cover |
| [#86](https://github.com/SplendidChip758/llama-paddock/issues/86) | Accessibility: keyboard, screen readers, contrast | Named in the checklist |
| [#15](https://github.com/SplendidChip758/llama-paddock/issues/15) | Agent versions and agent updates from the dashboard, with verified assets and recovery | Upgrade promise |
| [#87](https://github.com/SplendidChip758/llama-paddock/issues/87) | Backup and restore: config export, full pre-update backup, CLI restore | Recovery promise |
| [#48](https://github.com/SplendidChip758/llama-paddock/issues/48) | Dashboard update from the UI and the documented Docker path | Upgrade promise |
| [#34](https://github.com/SplendidChip758/llama-paddock/issues/34) | Run the checklist, record the evidence, make the deliberate semantic-release change | The gate itself |

**Explicitly not in 1.0.0:** anything in M6 to M13, including the Ollama updater (#74, now M8), the wall display and PWA (#11 and #12, now M13), the Windows service's full feature set (#148) and the quality lab (M11).

### Delivery order

Through 1.0.0: #82, then #59 and #18 together, then #86, then #15 and #87 together, then #48, then #34. Nothing else merges ahead of these unless it is a fix.

After 1.0.0, in slices, each gated by evidence before the next widens scope:

1. **Existing-fleet workflow.** M12 advanced diagnostics (GPU hardware health, slow-request explanation), the M6 Windows service full features, shared-PC mode and Docker Ollama, M8 maintenance mode, power profiles, sleep and wake, settings and model comparison, integration recipes. A pilot user can find and fix a recurring problem without scripts.
2. **Practical gateway.** M7 core with warm preference, bounded queues, locality, request IDs and the feedback endpoint. Fault tests prove safe cancellation and failover.
3. **Measured effectiveness.** M11 model quality lab: task suites, outcome feedback, bounded configuration tuning, saved profiles with rollback. A real task gets measurably better.
4. **Hardware-aware routing.** M9 core: registry, profiles, scheduler, policies, budgets, cost and energy, traces. Then learned routing from the outcome data.
5. **Broader operations.** More M6 backends, M10 single-host multi-GPU, M13 displays.
6. **Optional systems.** Cross-node sharding, a GPU provisioner, the simulator, agent orchestration: each justified on its own, from Later.

### 1.0 release checklist

This is the release gate; [#34](https://github.com/SplendidChip758/llama-paddock/issues/34) tracks its implementation and verification. A milestone's full **done when** line is not an extra 1.0 gate, except where an item below names it.

- M1's done-when checks pass, including verified connections and simulator regression checks. History and observed availability/model events survive restarts; missing observations remain unknown, and persistence failures are visible.
- M2's done-when checks pass: a model can be found in the library and created, a reproducible benchmark compares two hosts, and fit estimates state their assumptions and confidence. Unknown estimates and remote cloud models are clearly identified.
- Core M3 alerts and GPU/context diagnostics have reproducible simulator checks, including firing, resolution, flapping and observation gaps.
- M4 users, scoped API tokens and audit records work; permissions are enforced on the server, viewer/display credentials cannot mutate state, and existing login data migrates. Core controls work with a keyboard and expose accessible names.
- The agent protocol has a documented compatibility range independent of dashboard/agent release numbers. CI covers supported older agents, incompatible agents, and upgrade order.
- The Windows agent runs as a service and migrates from the scheduled task without losing its token.
- Supported stable upgrade paths and platform exceptions are documented. Automatic migrations, config/env compatibility and a documented stable `/api` are verified by CI starting from the latest stable 0.x release before 1.0. Subsequent 1.x releases test their supported stable predecessors.
- Agent updates and installer-based dashboard updates verify release assets, preserve credentials, and recover from interrupted or failed updates. Docker upgrades use the documented image-update command and are tested too.
- Configuration export/import and a consistent full pre-update backup are distinct and tested. Restoration recovers configuration, credentials and the database with a compatible application version, including when the UI is unavailable.
- Stable/prerelease channels are explicit; prerelease downgrades are outside the stable-upgrade promise. The deliberate 1.0 semantic-release change lands only after these checks pass.

## M1: Foundations

Several later features need these: alerts and benchmarks need stored data, and the gateway needs authenticated Ollama connections.

- **Persistent metric history.** Store metrics and job state in SQLite in the data directory, with retention and downsampling. Preserve sample counts/coverage and peaks alongside averages so gaps and short spikes remain visible. A failed persistent store must show a degraded status. Restart recovery resumes supported jobs and marks others interrupted explicitly.
- **Availability and model events.** Record Ollama and agent reachability separately, with timestamps, observation gaps, and model identities/digests for observed loads and unloads. An unreachable Ollama is not an idle host; a dashboard outage is unknown observation time. Polling can miss short-lived loads, so distinguish observed events from exact request usage. These records support M3 uptime/reload diagnostics and M8 cleanup/energy reports.
- **Simulated host and regression checks.** Build the fake Ollama/agent from [#82](https://github.com/SplendidChip758/llama-paddock/issues/82) in M1. CI exercises restart recovery, interrupted downloads, unavailable hosts, rejected credentials and TLS failures. Extend its scenarios for M3 alerts and M5 upgrades; a build alone is not a behavior test.
- **Long-range charts.** Pick a time range (1h / 24h / 7d / 30d) on the Monitor tab, as full charts rather than only sparklines.
- **Proxy keys for Ollama.** Ollama has no authentication of its own; connect to Ollama behind a proxy that checks a key or bearer token. The key is stored per host and set from **Add host** / **Edit host**.
- **Agent TLS.** Use HTTPS with a verified agent public-key pin or a trusted certificate, so bearer tokens are not exposed on the network. New installs default to HTTPS; existing HTTP hosts have an explicit migration path and visible warning. Never silently fall back to HTTP after TLS fails. Specify and test initial trust, key rotation, certificate renewal and Linux/Windows compatibility. Custom certificate generation or a shared HTTP/HTTPS port in [#68](https://github.com/SplendidChip758/llama-paddock/issues/68) must pass focused compatibility tests before adoption.
- **Prometheus `/metrics` endpoint.** Expose GPU, host and model metrics for Prometheus/Grafana. It is protected by a token, or can be opened for a scraper.
- **Version display.** Show the dashboard's version in the header, and each agent's version on its host page and in the fleet overview, so you can tell which build (stable or prerelease) is running. Older agents that don't report one show as unknown.

**Done when:** history and observed events survive a restart; gaps, peaks and persistence failures are visible; a week of GPU usage can be viewed; key-protected Ollama and verified agent HTTPS work; Grafana can scrape the fleet; versions are shown; and CI verifies restart, credential, transport and job-recovery scenarios.

## M2: Model workbench

Everything about choosing and tuning a model for your hardware. The whole workbench, including library browsing, uploads and fit filters, is required for 1.0. Testing and tuning models on your own tasks builds on it in M11.

- **GPU/CPU split everywhere.** The Monitor tab already shows the split for each loaded model. Show it on the fleet overview and in the Models tab too, and flag any model that isn't fully on the GPU, with a hint on what to change. Ollama's cloud models get their own badge, since prompts sent to them leave your network.
- **Create a new model from scratch.** A **New model** button instead of only Edit or Copy. The base can be a library model (pulled if missing), a Hugging Face GGUF or an uploaded GGUF. Set parameters, system prompt and template, or start from presets.
- **Browse the Ollama library.** Search and filter available models (capability, size, quantization) from the Pull dialog, and pull a tag directly. Ollama has no official search API, so this falls back to a plain pull by name if the source changes.
- **Fit estimates.** Estimate weights + KV cache + runtime overhead at a chosen context, accounting for parallel requests, other resident models and each GPU's placement/headroom. Report assumptions and confidence: likely fits / likely CPU offload / insufficient capacity / insufficient information. Where metadata permits, suggest the largest context likely to fit under those assumptions. Label measurements separately from predictions, skip remote cloud models, and avoid assuming that multiple GPUs behave as one pooled device.
- **Test prompt panel.** Chat with a model on a chosen host and see tokens/sec, time to first token and load time. Compare the same prompt on two hosts.
- **Benchmarks.** Run a standard prompt set and save prompt/generation tok/s, time to first token, load time, VRAM and split. Record model digest/quantization, context, parallelism, cache settings, hardware, Ollama/driver versions and cold versus warm state. Use repeated runs and show variation so comparisons across hosts and over time are meaningful; benchmarks are opt-in workloads.
- **"Fits on this GPU" filter.** Use the estimates and their confidence at the selected host/context/concurrency. Keep models with insufficient metadata identifiable rather than presenting a guaranteed fit; show measured speed only with the benchmark conditions.

**Done when:** you can find and create a model, compare a reproducible benchmark on two hosts, and assess fit with explicit assumptions and confidence. Unknown estimates and remote cloud models are clearly identified. These checks are part of the 1.0 checklist.

## M3: Alerts & diagnostics

Know when something breaks and why, with evidence. Hardware health, request explanations and advisor cards build on these alert rules and the GPU check in M12.

- **Alert rules.** GPU temperature, VRAM usage, host/agent offline, Ollama crashed or restarting, disk nearly full, model partly on CPU. Rules have thresholds, a duration ("for 2 minutes"), and apply to the whole fleet or to single hosts.
- **Notification channels.** Generic webhook, Discord, Slack and email (SMTP). Each rule can go to one or more channels, and each channel has a test button.
- **Alert history and uptime.** Persist firing/resolved transitions, affected-host badges and silences. Suppress repeats and flapping. Show Ollama and agent availability separately, using M1 observations; report observation coverage and unknown intervals rather than treating dashboard downtime as host uptime or failure.
- **GPU check.** Compare detected hardware with Ollama's observed placement and relevant discovery/error logs. Flag unexpected CPU fallback with evidence and a likely fix, while allowing intentional CPU-only/offload configurations. Missing telemetry alone must not be diagnosed as GPU loss.
- **Context and reload warnings.** Compare observed context with configured intent and flag possible overrides or truncation risk. A smaller context alone does not prove a client overrode it or that a prompt was truncated. Use M1 observed model events and available log evidence to identify reload churn, label incomplete evidence, and suggest likely causes.
- **Request log.** Requests per host from Ollama's own log: which clients call it, which endpoints, error rates and slow requests. No gateway needed. Prompts aren't recorded.
- **Security checks.** A page that checks each host and the dashboard itself: Ollama reachable without its key, an agent still on plain HTTP, the default password unchanged, data files readable by others. Each failing check links to the fix, and can send an alert.
- **Simulator coverage.** Extend M1's simulator for overheating, GPU loss, reload churn, disk pressure and notification delivery failures. Reuse it to verify alert durations, firing/resolution, repeat suppression, restarts and missing observations.

**Done when:** offline and overheating scenarios each deliver firing and resolved notifications through configured channels without flapping spam; unexpected GPU fallback and context/reload risks show supporting evidence; and uptime includes observation coverage. The full milestone also delivers request logs and security checks. Core alert/diagnostic behavior is reproducible with the M1 simulator.

## M4: Access & displays

Users, scoped tokens, audit records, accessibility and themes, all before 1.0. The wall display and the PWA build on the same credentials in M13; keep the credential design ready for display and gateway scopes.

- **Users and roles.** Several users, each with an **admin** role (full control) or a **viewer** role (read-only). Admins manage users in the UI. The current single login becomes the first admin.
- **API tokens.** Tokens for scripts, Home Assistant and cron jobs, stored hashed and shown once. Enforce explicit scopes and user permissions on every request, with expiry/revocation and no privilege increase after a role change. Display links and gateway keys (M7) build on the same credential mechanism but have distinct scopes; a display token must not grant general API or gateway access.
- **Audit log.** Who restarted, changed or deleted what, and when. Admins can filter it by user, host and action. No prompts, passwords or env values are recorded.
- **Themes.** A light / dark / system switch, built-in presets (including high contrast), and a custom theme editor for the accent, background, text and status colors, with a contrast check. Themes are saved per user and can be imported and exported as JSON. Charts and the wall display follow the theme.
- **Accessibility.** Keyboard navigation, screen reader labels, status never shown by colour alone, and reduced motion, checked in CI so it doesn't regress.

**Done when:** a viewer account can't change anything, a script can read the fleet with a viewer token, the dashboard works with a keyboard alone and with a screen reader, and each user can pick or build their own color theme.

## M5: Updates → 1.0

Safe upgrades and recovery on supported installations. The 1.0 checklist above is the release gate. Updating Ollama itself is fleet work and lives in M8.

- **Agent repository.** Move agents to their own repo with independent releases. Report a protocol version and capabilities so compatibility does not rely on comparing agent and dashboard version numbers. Document the supported range and test mixed-version fleets and upgrade order. Required before agent updates, so part of 1.0.
- **Windows service (base).** The Windows agent runs as a real Windows service with no logged-in user: service install and uninstall from the installer, start, stop and restart, logs in a known place, token and TLS identity preserved across updates, and a tested migration from the scheduled-task setup. The service starts and manages `ollama serve` itself in this version; the session helper for tray-app installs and the rest of the feature set follow in M6. Tracked as [#18](https://github.com/SplendidChip758/llama-paddock/issues/18) and part of 1.0.
- **Agent updates.** Offer compatible releases on the selected stable/prerelease channel. Verify release assets against `SHA256SUMS`, preserve tokens and TLS identity, replace atomically, check health and provide a tested recovery path. Show per-host outcomes, allow staged rollouts and stop a bulk rollout when its health checks fail.
- **Dashboard updates.** Check for a compatible newer release on the install's channel and show release notes. Installer installs use an admin-only, narrowly scoped privileged updater, a consistent full backup and post-update health checks. Docker installs show the image-update command; test that path and document its backup/restore steps. Do not promise one-click updates for unsupported installation methods.
- **Backup and restore.** Provide an encrypted configuration export for moving hosts, credentials, settings and users to a new install. Separately take a consistent full pre-update backup, including the database/history and required config/auth files, with schema/application versions. A config-only export is not an update rollback. Test restoration with the matching application version and provide a CLI recovery path when the UI is unavailable.
- **Prepare 1.0.** Verify the release checklist above and record the results in [#34](https://github.com/SplendidChip758/llama-paddock/issues/34), then make the deliberate semantic-release change.

**Done when:** the core agent/dashboard upgrade and recovery paths pass the 1.0 checklist, including the documented Docker command path and restoration to a fresh install. Then 1.0 is tagged.

## M6: Platforms

The Windows service base ships before 1.0 as part of M5; everything here is 1.x. For inference backends: one adapter contract, then one additional backend end to end, then others by demand. Read-only support is a valid first tier.

- **Windows service, full features.** Service mode with the user-session helper so a tray-app Ollama and its user environment variables work; both modes supported and tested; the installer chooses the mode and the scheduled task stays as a fallback; environment editing in both modes. The tray icon acts as the session helper. Shared-PC mode builds on this.
- **Windows tray icon.** Agent and Ollama status at a glance. A menu to open the dashboard, restart Ollama, open logs or copy the token. It also serves as the user-session helper for service mode.
- **Shared-PC mode.** Use a gaming or work PC as a node without giving it up. The tray menu gets Available / Not available / Automatic. In Automatic, the agent detects the user: input idle time, a fullscreen or foreground game, other processes using the GPU. While the user is active the host reports "shared, in use": the dashboard shows it, scheduling excludes it and the gateway drains in-flight requests. When the user returns to a host with a model loaded, the tray says which model and how much VRAM, with unload now or keep for a while, and unloads after a grace period unless kept. Idle thresholds and quiet hours are per host. Windows first via the tray; Linux desktops via the same agent state later. The host's availability windows are recorded so warm loading and routing can learn them.
- **WSL installer.** Install the agent inside WSL2 (systemd or not), including the Windows-side port forwarding/firewall needed for the dashboard to reach it.
- **Ollama in Docker.** The agent detects Ollama running in a container and restarts it, reads its logs and checks its version through the Docker API. Its environment is shown read-only, since compose owns it.
- **AMD GPUs (ROCm).** GPU stats via `amd-smi` / `rocm-smi`, shown in the same GPU cards as NVIDIA.
- **Apple Silicon and a macOS agent.** A launchd-based agent with unified-memory/GPU stats, environment editing via `launchctl setenv`, and Ollama app restart.
- **Local backend monitoring and management.** [#117](https://github.com/SplendidChip758/llama-paddock/issues/117) brings vLLM, LM Studio, llama.cpp server and Unsloth Studio/local inference into the fleet alongside Ollama. Use backend adapters to show service health, version, available versus observed loaded models, and supported context/request metrics; an optional agent supplies host/GPU utilization, VRAM, temperature, power and disk telemetry. Reuse history, charts, alerts and diagnostics. Start with read-only monitoring, then add supported model load/unload, download/delete, restart, logs and settings controls with permissions and audit records. Publish a tested backend/version/platform capability matrix: unknown metrics stay unknown, unsupported controls are explicit, and several inference instances on one host must not duplicate GPU totals. Preserve existing Ollama configuration and history. Monitoring can ship independently of M7; Unsloth training-job orchestration is separate scope.
- **GPU topology inventory.** Stable GPU identity (UUID/PCI), architecture and compute capability, driver, total/free/reserved memory, and where supported PCIe details, NUMA locality, peer access and NVLink; which GPUs share a host, VM or container. Unknown stays unknown; idle is never inferred from missing telemetry.
- **Per-GPU model placement.** For Ollama and each backend, which GPUs hold which loaded model and how much of each, so a multi-GPU host shows the real split and co-located backends never double count.
- **Runtime compatibility matrix.** Which backend versions run on which GPU generations (current vLLM needs compute capability 7.5+, so Pascal cards are Ollama and llama.cpp only). Used by fit estimates, M9 scheduling and M10 before any start action.

**Done when:** Linux, Windows (service + tray), WSL, Docker and macOS each have tested supported combinations in a published OS/runtime/GPU matrix, including NVIDIA, AMD and Apple support where applicable. Supported combinations report available metrics and management actions, and unsupported metrics/actions are clearly marked. Windows service/tray migration and Docker's read-only environment behavior are tested; full stats are not promised on every hardware/OS combination. For local inference backends, verify service health, supported actions and missing telemetry against the published backend matrix. A gaming PC joins the fleet, drops out automatically when its owner sits down and tells them what is loaded; a two-GPU host shows per-GPU placement; a known-incompatible runtime/GPU pair is flagged before use.

## M7: Routing gateway

The dashboard becomes the single entry point for the whole fleet. The first release is transparent routing with reliable streaming and access controls; provider support and optimization follow within M7. Choosing the model from the request itself is M9.

- **OpenAI-compatible API.** `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` and `/v1/models` on the dashboard, with streaming, forwarded to Ollama's OpenAI-compatible endpoints.
- **Fleet model catalog.** `/v1/models` lists every model available anywhere in the fleet, with optional aliases (e.g. `fast` → `qwen3:8b`).
- **Load balancing.** Route only to healthy, compatible instances with the requested model, considering model identity, current load, in-flight requests and headroom. Prefer warm models when capacity permits, but capability and policy come first and expected completion time next: a saturated warm host may lose to an idle cold one. Bound queues, timeouts and retries; retry another host only before any response content is emitted, as in [#24](https://github.com/SplendidChip758/llama-paddock/issues/24). After streaming starts, surface failures without replaying the request.
- **Rules and groups.** Group hosts (e.g. "gpu-big", "office"), and pin models or aliases to groups. Set priorities, fallbacks and per-key limits.
- **Client API keys and usage.** Issue keys for apps that call the gateway, with per-key request/token counts and logs. Keys are the M4 API tokens with a gateway scope, tied to users.
- **Streaming and cancellation.** Preserve streamed content and tool-call structure, apply backpressure, and propagate disconnects/timeouts upstream. Release concurrency slots on completion, cancellation and failure; test these with simulated upstreams.
- **Request identity and feedback.** Every gateway response carries a request ID. A feedback endpoint accepts an outcome for that ID (accepted, rejected, tests passed, retried), scoped to the key that made the request, metadata only. This is the signal M2's task suites and M9's learning consume.
- **Service classes.** Interactive, normal and background requests, with bounded per-class queues and simple fair share per key, so background agents never starve a chat. Delaying a start is supported; mid-token preemption is not claimed for any backend until measured.
- **Pull on demand.** Opt-in per alias: a request for a catalog model loaded nowhere pulls it on the host with the most headroom under a size limit, with a visible "pulling" state, then serves it.
- **Wake-host hold.** If the only eligible host is asleep (M8), hold the request with a visible "waking host" state and a bounded wait instead of failing.
- **Real-client fixtures.** CI tests tool calls, JSON schemas, streaming events, cancellation and errors with selected real clients, and the docs publish a client support matrix.

### After the core gateway ships

- **Other providers in the gateway.** [#27](https://github.com/SplendidChip758/llama-paddock/issues/27) routes to OpenAI-compatible services (OpenAI, OpenRouter, vLLM, llama.cpp server, LM Studio and Unsloth's local inference API) and the Anthropic API next to Ollama. Connect directly to Unsloth's [documented API](https://unsloth.ai/docs/basics/api) with its base URL and API key, starting with chat completions, streaming and supported tool calls. Verify backend/version/model capabilities instead of assuming every endpoint is supported; test authentication, unavailable models, cancellation and pre-response failover. Local-to-cloud fallback is opt-in and must respect local-only routes, including when an upstream can itself forward to cloud services. Reuse backend identities/capabilities from #117 where available. This is a likely 2.0 if it changes the supported host configuration or API contract; additive integrations can ship in 1.x.
- **Gateway optimization.** After the core gateway ships, [#36](https://github.com/SplendidChip758/llama-paddock/issues/36) can add opt-in prompt compression, response caching and routing affinity independently. Compression must preserve tool-call structure and pass task-quality checks; report end-to-end latency and compression cost as well as tokens saved. Cache keys must isolate users/permissions and include model identity and request settings, with invalidation rules. Treat affinity as best effort, not guaranteed upstream KV-cache reuse.

**Done when:** an authenticated app can discover and use its permitted fleet models; requests distribute within configured limits; pre-response failures can fail over; mid-stream failures do not trigger replay; and cancellation releases upstream work and capacity. An app can report an outcome for a request, a background job cannot starve interactive traffic, and the client fixtures pass. These checks gate the core release. For the follow-ups, verify permitted provider routes and measure optimization quality and overhead.

## M8: Fleet operations

Day-to-day work across many hosts: adding them, keeping them alike, and keeping their disks and power bills in check. Comparison, residency, maintenance mode and enrollment come first; remote SSH install and blob transfer later.

- **Maintenance mode and drain.** Mark a host as draining: no new work, in-flight requests finish, then it is safe to update or reboot. Used by updates, shared-PC mode and sleep.
- **Remote agent install.** Install the agent from the dashboard over SSH (or `pct exec` on a Proxmox host). The token and host entry fill in automatically.
- **Agent enrollment.** Give the installer an authenticated HTTPS dashboard URL and an expiring, single-use enrollment token; store only its verifier on the dashboard. Verify the dashboard certificate or explicitly provision its trust pin before sending credentials. Bind the agent identity/URL/fingerprint to the authorized enrollment, verify the callback over pinned agent TLS, and consume the token atomically to prevent concurrent reuse. Test expiry, replay, callback failure and retry behavior. Revise [#66](https://github.com/SplendidChip758/llama-paddock/issues/66) to this flow before implementation: a hashed token verifier cannot reconstruct the original secret for payload decryption.
- **Rented host as a normal host.** A cloud GPU pod you start yourself and enroll with the SSH installer appears as a host with a remote badge and never satisfies a local-only route. llama-paddock does everything after the renting.
- **Fleet-wide model actions.** Pull, delete or rename-copy a model on several hosts at once, with progress for each host in the Jobs drawer.
- **Copy models over the LAN.** Download a model from the internet once and copy its files to the other hosts from the dashboard, instead of every host downloading it. Ollama has no transfer API, so the agents move the blobs themselves and fall back to a normal pull when they can't.
- **Model comparison.** A matrix of models across hosts showing which are missing or out of date, with one click to sync.
- **Fleet-wide Ollama settings.** A matrix of Ollama's environment variables across hosts, with the differences highlighted. Save a set as a profile and apply it to several hosts at once, with each setting's VRAM cost where it can be estimated.
- **Model disk cleanup.** Use M1's per-model observations to show last observed load and evidence coverage. Suggest candidates only after enough observation time; never label a model unused solely because its history is missing. Account for shared blobs when estimating reclaimable space, exclude scheduled/retained models, and require explicit deletion.
- **Schedules and energy use.** Keep models loaded or preload/unload them on schedules with an explicit timezone. Integrate GPU power over observed time for daily/monthly energy and estimated cost, showing missing-data coverage. Label this GPU-only energy, not whole-host electricity use.
- **Usage-learned warm loading.** From M1 load events and gateway usage, learn which models are used when and where ("every weekday 09:00 on host A"). Recommend keep-alive and preload schedules with the trade-off shown: idle GPU power versus reload latency. Recommendation-only first; opt-in apply with cooldowns. Pins, schedules, shared-PC availability and in-flight requests are always respected.
- **Power profiles and tokens per watt.** The agent sets a per-GPU power limit. Benchmark each card at a few limits and show tokens per watt. Offer eco, balanced and performance profiles per host, applied with approval, with a measured result and a reset on restart if wanted.
- **Sleep and wake idle hosts.** Suspend or shut down a host after a configured idle period, excluding pinned models and shared PCs in use. Wake it by Wake-on-LAN or a Proxmox call when a request, a schedule or the warm-loading plan needs it; the gateway's wake-host hold covers the gap. Show expected and actual energy saved from measured GPU power.
- **Ollama updates.** [#74](https://github.com/SplendidChip758/llama-paddock/issues/74): show Ollama versions across the fleet, support pinning, stage updates host by host and offer rollback to the recorded previous version after failed health/GPU checks. State supported install/runtime modes explicitly; Docker and externally managed installs show instructions until a tested update adapter exists.
- **Fleet state over MQTT.** Optional: publish host, model and availability state so Home Assistant can show the fleet and trigger wake, sleep or shared-PC toggles.

**Done when:** a new host joins the fleet without copying a token, a model and a set of Ollama settings can be rolled out to every host at once, a model pulled on one host reaches the others without touching the internet, and the dashboard shows which models waste disk and what the fleet's GPUs cost to run. A host sleeps when idle and a request wakes it; a model used every morning is warm before the first request; a power profile shows measured tokens per watt; a rented pod shows as remote; Ollama can be updated, pinned and rolled back on supported installs.

## M9: Hardware-aware routing

The gateway picks the model and the host from what the fleet looks like right now and what the models have been measured to achieve on your tasks, explains every decision, and shows what it cost in money and electricity. Deterministic rules first; learning from real outcomes after. Needs the M7 core, M6 backend capabilities and M8 energy observations; cloud tiers also need M7 providers. The dashboard stays useful with M9 disabled.

- **Capability registry.** One queryable view of host, GPU, service, model and remote provider identities with modality, tool calling, embeddings, context limits, loaded versus listed state, and whether each value is declared, measured, inferred or unknown, with freshness. A shared schema designed with M6 and M7 that preserves existing IDs and history.
- **Performance profiles.** Per model/host/runtime profiles from M2 benchmarks: throughput, time to first token, load delay, VRAM, GPU power, cold versus warm, short versus long context, plus task-suite pass rates where they exist. An estimator reports observation count, age and uncertainty; insufficient data shows as such.
- **Hardware-aware scheduler.** Filter by health, capability, permission, locality and shared-PC availability first; then score warm residency, cold-load delay, queue depth, in-flight work, throughput and per-GPU headroom. Per-GPU capacity, atomic slot leases released on completion, cancellation and crash, deterministic tie-breaking, and fallback to M7 balancing when telemetry is stale. Never retries after streamed output.
- **Smart routing.** [#112](https://github.com/SplendidChip758/llama-paddock/issues/112): an `auto` alias picks a tier in steps and stops at the first confident answer: explicit signals (key or route, tools or images, prompt size), then cheap scoring (length, code or multi-step cues, similarity to example prompts with an already-loaded embedding model), then an optional small-model classifier with a timeout. Policies: Local Only, Local Preferred, Balanced, Quality First, Custom. A policy name never grants cloud access. A model's own confidence is not evidence; measured pass rates and deterministic checks are. Escalation only before any content is emitted. The log records the tier and the reason, not the prompt.
- **Cloud opt-in and budgets.** Cloud tiers are off on every new key and route; only an explicit per-key or per-route opt-in enables them, and global settings can only narrow that. Hard budgets reserve conservative spend before dispatch so concurrent requests can't overspend; exhaustion does a configured reject, stay-local or queue, never a silent escalation. Unknown upstream locality never counts as local; a trace shows what was authorized, not a claim about what an opaque upstream did afterwards.
- **Cost and energy accounting.** Cloud spend (estimated, unsettled, confirmed, with versioned prices) next to GPU-only energy from M8 observations and a configured tariff, with coverage gaps visible. Report cost per successful task using outcome feedback. Avoided spend needs a named baseline and is labelled as an estimate.
- **Routing Intelligence screen.** Per request: policy and router version, candidates, exclusion reasons, chosen tier, model and host, queue, load, execution, wake and budget events, predicted versus observed latency. Filter by key, policy, model, host and time. Metadata only by default; prompt capture is a separate opt-in with retention and deletion. Dry-run a policy against recent traces.
- **Review and learn.** A review inbox to confirm or correct routing decisions singly or in similar groups, excluding outliers before labelling; labels for route choice, answer quality, host failure and latency kept separate. Versioned export of reviewed decisions and outcome feedback, pre-dispatch features only, conversations kept in one split. Compare the rules, a lightweight classifier and an optional externally trained small model on held-out groups from this fleet. A candidate runs in shadow beside the active router, then on a scoped canary, then is promoted explicitly with the previous version kept for rollback. The policy guard stays authoritative; training stays external until it has proven its value.

**Done when:** on the simulator and a real mixed fleet, an `auto` route measurably beats M7 balancing on at least one of latency, reload count or cloud spend with no task-suite regression; a fresh install sends nothing to the cloud; concurrent requests cannot exceed a budget; every decision is explainable from its trace; the dashboard works with M9 disabled; and a candidate trained on this fleet's outcomes beats the rules on held-out groups before it is promoted.

## M10: Managed runtimes

Start, configure and stop inference runtimes from the dashboard, with single-host multi-GPU as the headline case. Optional; the dashboard never requires it. Cross-node sharding is not part of it (see Later).

- **Deployment spec and planner.** Choose a model artifact, runtime, context, concurrency and target GPUs on one host. The planner estimates per-GPU weights, KV cache and overhead using the runtime's own assumptions and M6's compatibility matrix, shows fit confidence, refuses incompatible or oversubscribed plans and offers alternatives. Aggregate VRAM is never shown as pooled capacity. Dry run and explicit approval before anything starts.
- **Lifecycle controller.** Desired-state deployments with a stable ID and a state machine (validating, reserved, starting, ready, serving, draining, stopped, degraded, failed). Reservations coordinate with M9 so a deployment's GPUs are never double-booked. Reconcile after dashboard or host restart; audit every host-level mutation.
- **Runtime adapters.** Ollama (observe and configure its own multi-GPU placement), llama.cpp server (explicit tensor split), vLLM (tensor parallel on supported GPUs). Only runtime-native, tested control paths; an OpenAI-compatible endpoint is not a management API.
- **One logical endpoint.** A multi-GPU deployment appears in the M7 catalog as one instance referencing all its GPUs. M9 scores it against single-GPU and cloud alternatives without counting it as several replicas.
- **Health and benchmark comparison.** Member and endpoint status shown separately; one failure marks the endpoint degraded, stops new dispatch and raises an M3 alert with evidence. The same M2 suite runs against the deployment, a single-GPU alternative and CPU offload, so users see when distribution is slower.

**Done when:** on a supported two-GPU host, a model that doesn't fit one GPU can be planned, approved, started, served through the gateway as one endpoint, benchmarked against alternatives and stopped with no orphaned process or reservation; incompatible GPU/runtime pairs are refused with a reason.

## M11: Model quality lab

Builds on the M2 workbench after 1.0: measure what models actually achieve on your own tasks, and tune them on that evidence instead of token speed alone.

- **Task suites.** Versioned sets of your own tasks per capability (coding change, debugging, JSON output, tool choice, summarizing, vision), with deterministic checks where possible: tests pass, schema valid, expected tool called, or an explicit human accept. Run the same suite against chosen local and authorized remote models with fixed prompts, sampling and context. Record digest, quantization, runtime settings, host, suite version and attempts. Show pass rate with sample size and uncertainty; a handful of tests is not a ranking. Uncovered capabilities show as unknown.
- **Outcome feedback.** Accept an application-reported result for a gateway request (accepted, rejected, tests passed, retried) by request ID, scoped per key, metadata only. HTTP 200 is not success. Retries and model switches are weak signals, never ground truth. The endpoint itself is M7's request identity and feedback; this milestone consumes it.
- **Tune a model on measured success.** Pick a model, a host and an objective (fastest interactive, longest usable context, lowest energy, balanced). Search a bounded set of per-model parameters (context, GPU layers, temperature, quantization variant, keep-alive) within an operator-set time and load budget on an approved host, run the task suite each time, and show pass rate, latency, VRAM, load delay and energy side by side. Save the winner as a versioned model variant, apply only with approval, keep the baseline for one-click rollback. Process-wide runtime settings, weight fine-tuning and LLM-generated prompt rewrites are out; human-authored prompt variants can be A/B tested.
- **Regression comparisons.** Re-run a saved suite after an Ollama, driver or settings change and show whether quality, latency or memory moved. Immutable profiles, preview, rollback.

**Done when:** a user defines a suite, tunes one model on their host, sees a measured pass-rate and latency change with sample size, applies it and rolls it back; a runtime update that regresses a suite is flagged; uncovered capabilities show as unknown.

## M12: Advanced diagnostics

Builds on M3 after 1.0: hardware-level health the agent can see, request-level explanations the gateway can measure, and recommendations grounded in both.

- **GPU hardware health check.** For each GPU the agent reports PCIe link width and generation versus the card's maximum, Xid errors from the kernel log, ECC and retired-page counts, throttle reasons (power, thermal, voltage, HW slowdown) and an opt-in short VRAM test. The page says what it likely means ("running at x4; check the riser or slot") and whether the fix is a setting, a cable, a driver or the card. Built for second-hand GPUs; unknown stays unknown.
- **Slow or failed request explanation.** One compact breakdown per gateway request: queue wait, cold load, prefill, generation, CPU offload, failure, with unknown components shown as such and the next diagnostic action apparent. Feeds M9 traces.
- **Per-alias SLO alerts.** A gateway alias declares a target (for example p95 time to first token under 2 s). Alert rules fire when the gateway's own measurements miss it, linking to the explanation above.
- **Advisor cards.** Rules-first recommendations grounded in existing telemetry: reload churn, memory pressure, unexpected CPU fallback, idle-energy mismatch, suite regressions. Each card shows the evidence, time range, confidence and a safe action (open a benchmark, show a config diff). Never changes anything itself. Accept, dismiss or mark unhelpful.

**Done when:** a GPU on a degraded link or with Xid errors is flagged with a likely cause on the simulator and on real hardware; a slow request is explained by component; an SLO miss raises a normal alert; advisor cards never fire without evidence.

## M13: Displays

Builds on M4's credentials after 1.0: more screens for the same fleet.

- **Wall display.** A view-only page for a wall-mounted screen or TV: large fleet overview, no controls, auto-refresh, dark theme, works without signing in via a revocable display link/token.
- **Mobile layout and PWA.** Usable on a phone. Installable as an app, with the alert badge visible.

**Done when:** a TV shows the fleet from a revocable display link without signing in, and the dashboard works from a phone home screen with the alert badge visible.

## Later

New ideas can be proposed through feature requests and assigned a milestone once their scope is clear. Detailed designs for the items below live in the [planning repository](https://github.com/SplendidChip758/llama-paddock-docs).

- **Cross-node model sharding.** Splitting one model across GPUs on different hosts. llama.cpp's RPC backend is documented by its maintainers as experimental and insecure, and vLLM multi-node needs modern GPUs and a trusted network. A lab spike on isolated hardware may inform it; unscheduled until a supported runtime path exists.
- **GPU capacity provisioner.** Quoting, renting, bootstrapping and terminating cloud GPUs from the dashboard with separate authorization and spend caps. M8's rented-host enrollment covers the manual path; evaluate existing provisioners before writing provider code.
- **Infrastructure simulator.** What-if comparisons (a new GPU, a bigger model, rented capacity versus API tokens) built from measured profiles with explicit uncertainty. Needs M2 extensions, M9 profiles and M6 topology first; the advisor cards shipped earlier in M3.
- **In-dashboard router training.** Only if external training proves its value in M9.
- **Agent orchestration.** Task boards, agent teams and tool approvals belong in a separate product that uses the gateway. llama-paddock's part is scoped keys, service classes, budgets and outcome feedback.
- **Integration recipes.** Not a milestone: a docs page per client (Open WebUI, Home Assistant, Continue and Cline, n8n, CLI tools) with a config snippet and a scoped key, written as each integration is tested.
