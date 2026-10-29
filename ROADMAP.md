# Roadmap

Where llama-paddock is headed, grouped into milestones. Each milestone has a **done when** line: the point where it counts as finished.

Progress is tracked in [GitHub milestones](https://github.com/SplendidChip758/llama-paddock/milestones) and their issues. This file is the overview, and the issues hold the details. Ideas and feedback are welcome: open a [feature request](https://github.com/SplendidChip758/llama-paddock/issues/new?template=feature_request.md).

| | Milestone | Theme | Version |
|---|---|---|---|
| M1 | [Foundations](#m1-foundations) | Data that survives a restart, secured Ollama and agents, Grafana | 0.x |
| M2 | [Model workbench](#m2-model-workbench) | Find, size, create and benchmark models | 0.x |
| M3 | [Alerts & diagnostics](#m3-alerts--diagnostics) | Find out when something breaks, and why | 0.x |
| M4 | [Access & displays](#m4-access--displays) | More people, more screens, your own colors | 0.x |
| M5 | [Updates](#m5-updates--10) | Update agents, Ollama and the dashboard from the UI | ends with **1.0** |
| M6 | [Platforms](#m6-platforms) | Run the agent everywhere Ollama runs | 1.x |
| M7 | [Routing gateway](#m7-routing-gateway) | One OpenAI-compatible API for the whole fleet | 1.x |
| M8 | [Fleet operations](#m8-fleet-operations) | Run many hosts as one | 1.x |
| | [Later](#later) | Other providers | 1.x or 2.0 |

## Versioning

Versions are cut by semantic-release from commit messages, so a milestone usually ships across several releases. A version number isn't a milestone reward. It tells users what an upgrade will cost them.

- **0.x (now).** Anything may change. Breaking changes only bump the minor version.
- **1.0** comes at the end of M5. By then the changes that are likely to break things are done:
  - the storage format (M1)
  - the switch from one login to user accounts (M4)
  - agent versioning and self-update (M5)

  1.0 then promises that upgrading within 1.x never needs a manual step. [#34](https://github.com/SplendidChip758/llama-paddock/issues/34) lists what has to be true before 1.0 is tagged.
- **After 1.0**, new features are minor releases, however big they are. Platforms (M6), the gateway (M7) and fleet operations (M8) are additions, so they ship as 1.x. They don't depend on each other, so their numbers aren't a strict order: work on them can overlap.
- **The major version goes up (2.0, 3.0, …)** only when an upgrade needs you to act:
  - the dashboard can no longer talk to agents from the previous major, and they can't update themselves
  - a config key, env var or `/api` endpoint is removed or changes meaning
  - the data directory can't be migrated automatically
  - a platform or the minimum Node.js version is dropped
- **A likely 2.0:** routing to other providers (see [Later](#later)). If "hosts" become general "providers" in the config and API, that change would be breaking.

## M1: Foundations

Several later features need these: alerts and benchmarks need stored data, and the gateway needs authenticated Ollama connections.

- **Persistent metric history.** Store metrics on disk (SQLite in the data directory) instead of in memory, with downsampling so weeks of data stay small, and a retention setting. Job state survives a restart too.
- **Long-range charts.** Pick a time range (1h / 24h / 7d / 30d) on the Monitor tab, as full charts rather than only sparklines.
- **Ollama API keys.** Connect to Ollama instances that sit behind an API key or bearer token (reverse proxy, hosted Ollama). The key is stored per host and set from **Add host** / **Edit host**.
- **Agent TLS.** The dashboard talks to agents over HTTPS instead of plain HTTP, so the agent token can't be read off the network. Each agent makes its own certificate, and the dashboard pins its fingerprint rather than relying on a CA. Agents keep answering plain HTTP on the same port, so existing hosts keep working until they're switched.
- **Prometheus `/metrics` endpoint.** Expose GPU, host and model metrics for Prometheus/Grafana. It is protected by a token, or can be opened for a scraper.
- **Version display.** Show the dashboard's version in the header, and each agent's version on its host page and in the fleet overview, so you can tell which build (stable or prerelease) is running. Older agents that don't report one show as unknown.

**Done when:** a dashboard restart keeps its history, you can view a week of GPU usage, a key-protected Ollama works, agent traffic is encrypted, Grafana can scrape the fleet, and the UI shows which dashboard and agent versions are running.

## M2: Model workbench

Everything about choosing and tuning a model for your hardware.

- **GPU/CPU split everywhere.** The Monitor tab already shows the split for each loaded model. Show it on the fleet overview and in the Models tab too, and flag any model that isn't fully on the GPU, with a hint on what to change.
- **Create a new model from scratch.** A **New model** button instead of only Edit or Copy. The base can be a library model (pulled if missing), a Hugging Face GGUF or an uploaded GGUF. Set parameters, system prompt and template, or start from presets.
- **Browse the Ollama library.** Search and filter available models (capability, size, quantization) from the Pull dialog, and pull a tag directly. Ollama has no official search API, so this falls back to a plain pull by name if the source changes.
- **Fit estimates.** Estimate the memory a model needs at a given context length (weights + KV cache + overhead) and compare it with each GPU: fits / partly on CPU / doesn't fit, plus the largest context that still fits.
- **Test prompt panel.** Chat with a model on a chosen host and see tokens/sec, time to first token and load time. Compare the same prompt on two hosts.
- **Benchmarks.** Run a standard prompt set on a host and save prompt and generation tok/s, time to first token, VRAM and split. Compare across hosts, models and quantizations.
- **"Fits on this GPU" filter.** In the library browser, pick a host/GPU and a context length, and see only the models that fit, with expected speed where benchmarks exist.

**Done when:** you can find a model in the library, see whether it fits on a chosen GPU at your context length, create a custom model without a local copy, and benchmark it.

## M3: Alerts & diagnostics

- **Alert rules.** GPU temperature, VRAM usage, host/agent offline, Ollama crashed or restarting, disk nearly full, model partly on CPU. Rules have thresholds, a duration ("for 2 minutes"), and apply to the whole fleet or to single hosts.
- **Notification channels.** Generic webhook, Discord, Slack and email (SMTP). Each rule can go to one or more channels, and each channel has a test button.
- **Alert history.** A list of fired and resolved alerts in the UI, with a badge on affected hosts. Repeats are suppressed so a flapping host doesn't spam you.
- **GPU check.** Spot the case where `nvidia-smi` sees the GPU but Ollama has fallen back to the CPU, for example after a suspend and resume or a driver update. Show the relevant log lines, the likely cause and a fix to run.
- **Context and reload warnings.** Flag models that a client loaded with a smaller context than the host is set to, so long prompts get cut off without an error, and models that reload over and over because clients keep changing `num_ctx` or ignore `keep_alive`.
- **Request log.** Requests per host from Ollama's own log: which clients call it, which endpoints, error rates and slow requests. No gateway needed. Prompts aren't recorded.

**Done when:** a host going offline and an overheating GPU each send a Discord message and an email, and a matching "resolved" message follows. A host that loses its GPU, or a client that cuts its context short, is flagged with the likely fix, and each host shows which clients call it.

## M4: Access & displays

- **Users and roles.** Several users, each with an **admin** role (full control) or a **viewer** role (read-only). Admins manage users in the UI. The current single login becomes the first admin.
- **Wall display.** A view-only page for a wall-mounted screen or TV: large fleet overview, no controls, auto-refresh, dark theme, works without signing in via a revocable display link/token.
- **Mobile layout and PWA.** Usable on a phone. Installable as an app, with the alert badge visible.
- **Themes.** A light / dark / system switch, built-in presets (including high contrast), and a custom theme editor for the accent, background, text and status colors, with a contrast check. Themes are saved per user and can be imported and exported as JSON. Charts and the wall display follow the theme.

**Done when:** a viewer account can't change anything, a TV shows the fleet from a display link, the dashboard works on a phone home screen, and each user can pick or build their own color theme.

## M5: Updates → 1.0

Keeping the fleet current without SSH, and the changes 1.0 has to wait for.

- **Agent repository.** The agents move to their own repo with their own releases, so an agent fix doesn't need a dashboard release. A protocol version in `/health` says which agents and dashboards work together.
- **Agent updates.** Flag agents older than the latest agent release, and update one or all of them from the dashboard using the release assets and `SHA256SUMS`.
- **Dashboard updates.** Check for a newer release on the install's channel (stable or prerelease) and show it with its release notes. On installer installs, one click updates the dashboard after backing up its data. Docker installs show the command to pull the new image.
- **Ollama updates.** Show each host's Ollama version and flag hosts that are behind. Update one host or all of them, pin a host to its version, and roll back when an update breaks GPU use.
- **Prepare 1.0.** Versioned agent protocol, automatic data migrations, documented `/api`, an upgrade test in CI, and the semantic-release change that cuts 1.0.0.

**Done when:** every agent, every host's Ollama and the dashboard itself can be updated from the UI, and a bad Ollama update rolled back, without opening a terminal. Then 1.0 is tagged.

## M6: Platforms

- **Windows agent as a Windows service.** Run without a logged-in user. The tricky part: Ollama for Windows is a tray app that reads *user* environment variables. The service has to either start and manage `ollama serve` itself, or work with a small helper in the user's session. Both modes should be supported, with the logon task kept as a fallback.
- **Windows tray icon.** Agent and Ollama status at a glance. A menu to open the dashboard, restart Ollama, open logs or copy the token. It also serves as the user-session helper for service mode.
- **WSL installer.** Install the agent inside WSL2 (systemd or not), including the Windows-side port forwarding/firewall needed for the dashboard to reach it.
- **AMD GPUs (ROCm).** GPU stats via `amd-smi` / `rocm-smi`, shown in the same GPU cards as NVIDIA.
- **Apple Silicon and a macOS agent.** A launchd-based agent with unified-memory/GPU stats, environment editing via `launchctl setenv`, and Ollama app restart.

**Done when:** each of Linux, Windows (service + tray), WSL and macOS with NVIDIA, AMD or Apple GPUs shows full stats and can be managed.

## M7: Routing gateway

Similar in spirit to OmniRoute: the dashboard becomes the single entry point for the whole fleet.

- **OpenAI-compatible API.** `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` and `/v1/models` on the dashboard, with streaming, forwarded to Ollama's OpenAI-compatible endpoints.
- **Fleet model catalog.** `/v1/models` lists every model available anywhere in the fleet, with optional aliases (e.g. `fast` → `qwen3:8b`).
- **Load balancing.** Send each request to a healthy instance that has the model, preferring ones where it's already loaded and with free VRAM. Retry on another instance if one fails.
- **Rules and groups.** Group hosts (e.g. "gpu-big", "office"), and pin models or aliases to groups. Set priorities, fallbacks and per-key limits.
- **Client API keys and usage.** Issue keys for apps that call the gateway, with per-key request/token counts and logs. Keys are tied to the M4 users.
- **Token compression and caching.** Optional prompt compression (trim or summarize old turns of long chats, shrink bulky tool output), a response cache for repeated requests, and sticky routing so a conversation keeps hitting the same KV cache. Tokens saved show in the usage stats.

**Done when:** an app pointed at `http://paddock:8080/v1` with a key can use any model in the fleet. Requests spread across hosts and fail over when one goes down, and compression measurably cuts tokens on long chats.

## M8: Fleet operations

Day-to-day work across many hosts: adding them, keeping them alike, and keeping their disks and power bills in check.

- **Remote agent install.** Install the agent from the dashboard over SSH (or `pct exec` on a Proxmox host). The token and host entry fill in automatically.
- **Agent enrollment.** Give the agent installer the dashboard's address and a one-time enrollment code, and the host adds itself: no copying URLs and tokens. Codes are single use and expire, and the exchange is encrypted with the code, so nothing else on the network can enroll a host or read the agent's token.
- **Fleet-wide model actions.** Pull, delete or copy a model on several hosts at once, with progress for each host in the Jobs drawer.
- **Model comparison.** A matrix of models across hosts showing which are missing or out of date, with one click to sync.
- **Fleet-wide Ollama settings.** A matrix of Ollama's environment variables across hosts, with the differences highlighted. Save a set as a profile and apply it to several hosts at once, with each setting's VRAM cost where it can be estimated.
- **Model disk cleanup.** Each model's size and when it was last loaded. List models unused for 30 days or more, with the space deleting them would really free, since models share blobs, and delete them in one go.
- **Schedules and energy use.** Keep a model loaded, or preload and unload it on a schedule, such as warm on weekdays from 08:00 to 18:00. Show each host's GPU energy use per day and month, with an estimated cost.

**Done when:** a new host joins the fleet without copying a token, a model and a set of Ollama settings can be rolled out to every host at once, and the dashboard shows which models waste disk and what the fleet's GPUs cost to run.

## Later

- **Other providers in the gateway.** Route to OpenAI-compatible services (OpenAI, Anthropic, OpenRouter, vLLM, llama.cpp server, LM Studio) next to Ollama, with fallback from local to cloud. This is a likely 2.0 if it changes how hosts are configured.
- Ideas from issues and discussions land here first.
