# Roadmap

Where llama-paddock is headed, grouped into milestones. Each milestone has a **done when** line: the point where it counts as finished.

Progress is tracked in [GitHub milestones](https://github.com/SplendidChip758/llama-paddock/milestones) and their issues. This file is the overview, and the issues hold the details. Ideas and feedback are welcome: open a [feature request](https://github.com/SplendidChip758/llama-paddock/issues/new?template=feature_request.md).

| | Milestone | Theme | Version |
|---|---|---|---|
| M1 | [Foundations](#m1-foundations) | Reliable history, secure connections, automated checks, Grafana | 0.x |
| M2 | [Model workbench](#m2-model-workbench) | Find, size, create and benchmark models | 0.x / 1.x |
| M3 | [Alerts & diagnostics](#m3-alerts--diagnostics) | Find out when something breaks, and why | core 0.x; extensions 1.x |
| M4 | [Access & displays](#m4-access--displays) | Permissions first, then more screens and themes | 0.x / 1.x |
| M5 | [Updates](#m5-updates--10) | Tested upgrades and recovery; optional Ollama updates | core ends with **1.0** |
| M6 | [Platforms](#m6-platforms) | Run the agent everywhere Ollama runs | 1.x |
| M7 | [Routing gateway](#m7-routing-gateway) | One OpenAI-compatible API for the whole fleet | 1.x |
| M8 | [Fleet operations](#m8-fleet-operations) | Run many hosts as one | 1.x |
| | [Later](#later) | Gateway optimization and other providers | 1.x or 2.0 |

This is the milestone scope, not a list of features already available. Some items may already be implemented on `dev` or in a release; use the linked issues and milestones for status, and the [user guides](docs/README.md) for current behavior.

## Versioning

Versions are cut by semantic-release from commit messages, so a milestone usually ships across several releases. A version number isn't a milestone reward. It tells users what an upgrade will cost them.

- **0.x (now).** Anything may change. Breaking changes only bump the minor version.
- **1.0** follows the M5 core and the release checklist below. It promises that supported stable upgrades within 1.x preserve configuration, data and API compatibility without hand-editing files or repairing migrations. Starting an update, running the documented Docker update command, or approving an update is still a normal operator action.
- **Milestone completion and 1.0 readiness are separate.** M2's advanced workbench, M4's wall display/PWA/custom themes, and M5's Ollama updater can finish after 1.0. Their full milestone scope remains below; none is a release blocker.
- **After 1.0**, new features are minor releases, however big they are. Platforms (M6), the gateway (M7) and fleet operations (M8) are additions, so they ship as 1.x. They don't depend on each other, so their numbers aren't a strict order: work on them can overlap.
- **The major version goes up (2.0, 3.0, …)** when an upgrade breaks the supported compatibility contract, for example:
  - the dashboard can no longer talk to agents from the previous major, and they can't update themselves
  - a config key, env var or `/api` endpoint is removed or changes meaning
  - the data directory can't be migrated automatically
  - a platform or the minimum Node.js version is dropped
- **A likely 2.0:** routing to other providers (see [Later](#later)). If "hosts" become general "providers" in the config and API, that change would be breaking.

### Delivery order

Milestone numbers group related work; they are not a strict queue. Finish M1, including the simulator and the data needed for diagnostics, then prioritize M3 alerts and GPU/context diagnostics. Bring forward M2's split display and basic prompt/benchmark comparison where useful. Complete M4's users, scoped tokens, audit log and core accessibility before M5's privileged update controls.

After the 1.0 checklist passes, fleet actions and settings profiles (M8) can ship independently of new platforms (M6) and the gateway (M7). Library browsing, advanced fit filters, display customization and gateway optimization should not hold up dependable monitoring or recovery.

### 1.0 release checklist

This is the release gate; [#34](https://github.com/SplendidChip758/llama-paddock/issues/34) tracks its implementation and verification. A milestone's full **done when** line is not an extra 1.0 gate.

- M1's done-when checks pass, including verified connections and simulator regression checks. History and observed availability/model events survive restarts; missing observations remain unknown, and persistence failures are visible.
- Core M3 alerts and GPU/context diagnostics have reproducible simulator checks, including firing, resolution, flapping and observation gaps.
- M4 users, scoped API tokens and audit records work; permissions are enforced on the server, viewer/display credentials cannot mutate state, and existing login data migrates. Core controls work with a keyboard and expose accessible names.
- The agent protocol has a documented compatibility range independent of dashboard/agent release numbers. CI covers supported older agents, incompatible agents, and upgrade order.
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
- **Ollama API keys.** Connect to Ollama instances that sit behind an API key or bearer token (reverse proxy, hosted Ollama). The key is stored per host and set from **Add host** / **Edit host**.
- **Agent TLS.** Use HTTPS with a verified agent public-key pin or a trusted certificate, so bearer tokens are not exposed on the network. New installs default to HTTPS; existing HTTP hosts have an explicit migration path and visible warning. Never silently fall back to HTTP after TLS fails. Specify and test initial trust, key rotation, certificate renewal and Linux/Windows compatibility. Custom certificate generation or a shared HTTP/HTTPS port in [#68](https://github.com/SplendidChip758/llama-paddock/issues/68) must pass focused compatibility tests before adoption.
- **Prometheus `/metrics` endpoint.** Expose GPU, host and model metrics for Prometheus/Grafana. It is protected by a token, or can be opened for a scraper.
- **Version display.** Show the dashboard's version in the header, and each agent's version on its host page and in the fleet overview, so you can tell which build (stable or prerelease) is running. Older agents that don't report one show as unknown.

**Done when:** history and observed events survive a restart; gaps, peaks and persistence failures are visible; a week of GPU usage can be viewed; key-protected Ollama and verified agent HTTPS work; Grafana can scrape the fleet; versions are shown; and CI verifies restart, credential, transport and job-recovery scenarios.

## M2: Model workbench

Everything about choosing and tuning a model for your hardware. Ship split visibility and a basic prompt/benchmark comparison first. The full workbench can finish in 1.x; library browsing, uploads and fit filters do not gate 1.0.

- **GPU/CPU split everywhere.** The Monitor tab already shows the split for each loaded model. Show it on the fleet overview and in the Models tab too, and flag any model that isn't fully on the GPU, with a hint on what to change. Ollama's cloud models get their own badge, since prompts sent to them leave your network.
- **Create a new model from scratch.** A **New model** button instead of only Edit or Copy. The base can be a library model (pulled if missing), a Hugging Face GGUF or an uploaded GGUF. Set parameters, system prompt and template, or start from presets.
- **Browse the Ollama library.** Search and filter available models (capability, size, quantization) from the Pull dialog, and pull a tag directly. Ollama has no official search API, so this falls back to a plain pull by name if the source changes.
- **Fit estimates.** Estimate weights + KV cache + runtime overhead at a chosen context, accounting for parallel requests, other resident models and each GPU's placement/headroom. Report assumptions and confidence: likely fits / likely CPU offload / insufficient capacity / insufficient information. Where metadata permits, suggest the largest context likely to fit under those assumptions. Label measurements separately from predictions, skip remote cloud models, and avoid assuming that multiple GPUs behave as one pooled device.
- **Test prompt panel.** Chat with a model on a chosen host and see tokens/sec, time to first token and load time. Compare the same prompt on two hosts.
- **Benchmarks.** Run a standard prompt set and save prompt/generation tok/s, time to first token, load time, VRAM and split. Record model digest/quantization, context, parallelism, cache settings, hardware, Ollama/driver versions and cold versus warm state. Use repeated runs and show variation so comparisons across hosts and over time are meaningful; benchmarks are opt-in workloads.
- **"Fits on this GPU" filter.** Use the estimates and their confidence at the selected host/context/concurrency. Keep models with insufficient metadata identifiable rather than presenting a guaranteed fit; show measured speed only with the benchmark conditions.

**Done when:** you can find and create a model, compare a reproducible benchmark on two hosts, and assess fit with explicit assumptions and confidence. Unknown estimates and remote cloud models are clearly identified. This full scope may complete after 1.0.

## M3: Alerts & diagnostics

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

Users, scoped tokens, audit records and core accessibility are required before 1.0. Wall displays, PWA packaging and custom themes can follow without delaying it. Keep the shared credential design ready for display and gateway scopes.

- **Users and roles.** Several users, each with an **admin** role (full control) or a **viewer** role (read-only). Admins manage users in the UI. The current single login becomes the first admin.
- **API tokens.** Tokens for scripts, Home Assistant and cron jobs, stored hashed and shown once. Enforce explicit scopes and user permissions on every request, with expiry/revocation and no privilege increase after a role change. Display links and gateway keys (M7) build on the same credential mechanism but have distinct scopes; a display token must not grant general API or gateway access.
- **Audit log.** Who restarted, changed or deleted what, and when. Admins can filter it by user, host and action. No prompts, passwords or env values are recorded.
- **Wall display.** A view-only page for a wall-mounted screen or TV: large fleet overview, no controls, auto-refresh, dark theme, works without signing in via a revocable display link/token.
- **Mobile layout and PWA.** Usable on a phone. Installable as an app, with the alert badge visible.
- **Themes.** A light / dark / system switch, built-in presets (including high contrast), and a custom theme editor for the accent, background, text and status colors, with a contrast check. Themes are saved per user and can be imported and exported as JSON. Charts and the wall display follow the theme.
- **Accessibility.** Keyboard navigation, screen reader labels, status never shown by colour alone, and reduced motion, checked in CI so it doesn't regress.

**Done when:** a viewer account can't change anything, a script can read the fleet with a viewer token, a TV shows the fleet from a display link, the dashboard works on a phone home screen and with a keyboard alone, and each user can pick or build their own color theme.

## M5: Updates → 1.0

The core is safe upgrades and recovery on supported installations. The 1.0 checklist above is the release gate; Ollama updating is an optional follow-up, consistent with [#74](https://github.com/SplendidChip758/llama-paddock/issues/74).

- **Agent repository.** Move agents to their own repo with independent releases. Report a protocol version and capabilities so compatibility does not rely on comparing agent and dashboard version numbers. Document the supported range and test mixed-version fleets and upgrade order.
- **Agent updates.** Offer compatible releases on the selected stable/prerelease channel. Verify release assets against `SHA256SUMS`, preserve tokens and TLS identity, replace atomically, check health and provide a tested recovery path. Show per-host outcomes, allow staged rollouts and stop a bulk rollout when its health checks fail.
- **Dashboard updates.** Check for a compatible newer release on the install's channel and show release notes. Installer installs use an admin-only, narrowly scoped privileged updater, a consistent full backup and post-update health checks. Docker installs show the image-update command; test that path and document its backup/restore steps. Do not promise one-click updates for unsupported installation methods.
- **Backup and restore.** Provide an encrypted configuration export for moving hosts, credentials, settings and users to a new install. Separately take a consistent full pre-update backup, including the database/history and required config/auth files, with schema/application versions. A config-only export is not an update rollback. Test restoration with the matching application version and provide a CLI recovery path when the UI is unavailable.
- **Ollama updates.** Optional after the 1.0 core: show versions, support pinning, stage updates and offer rollback to the recorded previous version after failed health/GPU checks. State supported install/runtime modes explicitly; Docker and externally managed installs show instructions until a tested update adapter exists.
- **Prepare 1.0.** Verify the release checklist above and record the results in [#34](https://github.com/SplendidChip758/llama-paddock/issues/34), then make the deliberate semantic-release change. Optional workbench/display features and Ollama updates are not blockers.

**Done when:** the core agent/dashboard upgrade and recovery paths pass the 1.0 checklist, including the documented Docker command path and restoration to a fresh install. Then 1.0 is tagged. The optional Ollama updater completes separately when its supported platforms pass update, pinning and rollback checks.

## M6: Platforms

- **Windows agent as a Windows service.** Run without a logged-in user. The tricky part: Ollama for Windows is a tray app that reads *user* environment variables. The service has to either start and manage `ollama serve` itself, or work with a small helper in the user's session. Both modes should be supported, with the logon task kept as a fallback.
- **Windows tray icon.** Agent and Ollama status at a glance. A menu to open the dashboard, restart Ollama, open logs or copy the token. It also serves as the user-session helper for service mode.
- **WSL installer.** Install the agent inside WSL2 (systemd or not), including the Windows-side port forwarding/firewall needed for the dashboard to reach it.
- **Ollama in Docker.** The agent detects Ollama running in a container and restarts it, reads its logs and checks its version through the Docker API. Its environment is shown read-only, since compose owns it.
- **AMD GPUs (ROCm).** GPU stats via `amd-smi` / `rocm-smi`, shown in the same GPU cards as NVIDIA.
- **Apple Silicon and a macOS agent.** A launchd-based agent with unified-memory/GPU stats, environment editing via `launchctl setenv`, and Ollama app restart.

**Done when:** Linux, Windows (service + tray), WSL, Docker and macOS each have tested supported combinations in a published OS/runtime/GPU matrix, including NVIDIA, AMD and Apple support where applicable. Supported combinations report available metrics and management actions, and unsupported metrics/actions are clearly marked. Windows service/tray migration and Docker's read-only environment behavior are tested; full stats are not promised on every hardware/OS combination.

## M7: Routing gateway

Similar in spirit to OmniRoute: the dashboard becomes the single entry point for the whole fleet. The first release is transparent routing with reliable streaming and access controls; prompt transformation and response caching are separate follow-ups under Later.

- **OpenAI-compatible API.** `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` and `/v1/models` on the dashboard, with streaming, forwarded to Ollama's OpenAI-compatible endpoints.
- **Fleet model catalog.** `/v1/models` lists every model available anywhere in the fleet, with optional aliases (e.g. `fast` → `qwen3:8b`).
- **Load balancing.** Route only to healthy, compatible instances with the requested model, considering model identity, current load, in-flight requests and headroom. Prefer warm models when capacity permits. Bound queues, timeouts and retries; retry another host only before any response content is emitted, as in [#24](https://github.com/SplendidChip758/llama-paddock/issues/24). After streaming starts, surface failures without replaying the request.
- **Rules and groups.** Group hosts (e.g. "gpu-big", "office"), and pin models or aliases to groups. Set priorities, fallbacks and per-key limits.
- **Client API keys and usage.** Issue keys for apps that call the gateway, with per-key request/token counts and logs. Keys are the M4 API tokens with a gateway scope, tied to users.
- **Streaming and cancellation.** Preserve streamed content and tool-call structure, apply backpressure, and propagate disconnects/timeouts upstream. Release concurrency slots on completion, cancellation and failure; test these with simulated upstreams.

**Done when:** an authenticated app can discover and use its permitted fleet models; requests distribute within configured limits; pre-response failures can fail over; mid-stream failures do not trigger replay; and cancellation releases upstream work and capacity. Compression, response caching and guaranteed KV-cache reuse are not required.

## M8: Fleet operations

Day-to-day work across many hosts: adding them, keeping them alike, and keeping their disks and power bills in check.

- **Remote agent install.** Install the agent from the dashboard over SSH (or `pct exec` on a Proxmox host). The token and host entry fill in automatically.
- **Agent enrollment.** Give the installer an authenticated HTTPS dashboard URL and an expiring, single-use enrollment token; store only its verifier on the dashboard. Verify the dashboard certificate or explicitly provision its trust pin before sending credentials. Bind the agent identity/URL/fingerprint to the authorized enrollment, verify the callback over pinned agent TLS, and consume the token atomically to prevent concurrent reuse. Test expiry, replay, callback failure and retry behavior. Revise [#66](https://github.com/SplendidChip758/llama-paddock/issues/66) to this flow before implementation: a hashed token verifier cannot reconstruct the original secret for payload decryption.
- **Fleet-wide model actions.** Pull, delete or rename-copy a model on several hosts at once, with progress for each host in the Jobs drawer.
- **Copy models over the LAN.** Download a model from the internet once and copy its files to the other hosts from the dashboard, instead of every host downloading it. Ollama has no transfer API, so the agents move the blobs themselves and fall back to a normal pull when they can't.
- **Model comparison.** A matrix of models across hosts showing which are missing or out of date, with one click to sync.
- **Fleet-wide Ollama settings.** A matrix of Ollama's environment variables across hosts, with the differences highlighted. Save a set as a profile and apply it to several hosts at once, with each setting's VRAM cost where it can be estimated.
- **Model disk cleanup.** Use M1's per-model observations to show last observed load and evidence coverage. Suggest candidates only after enough observation time; never label a model unused solely because its history is missing. Account for shared blobs when estimating reclaimable space, exclude scheduled/retained models, and require explicit deletion.
- **Schedules and energy use.** Keep models loaded or preload/unload them on schedules with an explicit timezone. Integrate GPU power over observed time for daily/monthly energy and estimated cost, showing missing-data coverage. Label this GPU-only energy, not whole-host electricity use.

**Done when:** a new host joins the fleet without copying a token, a model and a set of Ollama settings can be rolled out to every host at once, a model pulled on one host reaches the others without touching the internet, and the dashboard shows which models waste disk and what the fleet's GPUs cost to run.

## Later

- **Gateway optimization.** After M7, [#36](https://github.com/SplendidChip758/llama-paddock/issues/36) can add opt-in prompt compression, response caching and routing affinity independently. Compression must preserve tool-call structure and pass task-quality checks; report end-to-end latency and compression cost as well as tokens saved. Cache keys must isolate users/permissions and include model identity and request settings, with invalidation rules. Treat affinity as best effort, not guaranteed upstream KV-cache reuse.
- **Other providers in the gateway.** Route to OpenAI-compatible services (OpenAI, Anthropic, OpenRouter, vLLM, llama.cpp server, LM Studio) next to Ollama, with fallback from local to cloud. This is a likely 2.0 if it changes how hosts are configured.
- Ideas from issues and discussions land here first.

**Done when:** each follow-up has its own reviewed scope and acceptance checks; none blocks 1.0 or the initial M7 gateway.
