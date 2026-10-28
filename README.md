<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/banner-dark.svg">
    <img alt="llama-paddock" src="docs/logo/banner-light.svg" width="560">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/SplendidChip758/llama-paddock/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/SplendidChip758/llama-paddock?style=flat-square&color=c8a04a&label=release"></a>
  <a href="https://github.com/SplendidChip758/llama-paddock/releases"><img alt="Latest prerelease" src="https://img.shields.io/github/v/release/SplendidChip758/llama-paddock?include_prereleases&sort=semver&filter=*-dev*&style=flat-square&color=8a6d2f&label=prerelease"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-c8a04a?style=flat-square"></a>
  <a href="https://github.com/SplendidChip758/llama-paddock/commits"><img alt="Last commit" src="https://img.shields.io/github/last-commit/SplendidChip758/llama-paddock?style=flat-square"></a>
  <a href="https://github.com/SplendidChip758/llama-paddock/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/SplendidChip758/llama-paddock?style=flat-square"></a>
  <br>
  <img alt="Ollama" src="https://img.shields.io/badge/Ollama-compatible-1b1814?style=flat-square&logo=ollama&logoColor=white">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-1b1814?style=flat-square&logo=nextdotjs&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/agent-Node.js%20%E2%89%A518.15-1b1814?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Platforms" src="https://img.shields.io/badge/hosts-Linux%20%7C%20Windows-1b1814?style=flat-square">
  <img alt="Docker" src="https://img.shields.io/badge/dashboard-Docker-1b1814?style=flat-square&logo=docker&logoColor=white">
</p>

<p align="center">
  <a href="#quick-install">Install</a> ·
  <a href="#using-it">Features</a> ·
  <a href="#api">API</a> ·
  <a href="https://github.com/SplendidChip758/llama-paddock/issues">Issues</a>
</p>

A self-hosted dashboard for monitoring and managing a fleet of Ollama instances on Linux and Windows.

**Monitor:** `ollama ps` (loaded models, context, VRAM/CPU split, unload timer), `nvidia-smi` (utilization, VRAM, temperature, power, clocks, PCIe, per-process VRAM), and host stats (CPU per core, RAM, disks incl. `OLLAMA_MODELS`, network, Ollama memory and runner count), with sparkline history.

**Manage:** pull models with live progress; list, load, unload, copy and delete models; edit models (context window, sampling parameters, stop sequences, system prompt); view and edit Ollama's environment variables and restart Ollama; tail Ollama's logs.

![Fleet overview](docs/images/overview.png)

## Quick install

Run these on a **Proxmox VE host**, or inside an existing LXC/VM:

```bash
# Dashboard: creates its own LXC when run on the Proxmox host
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/dashboard.sh)"

# Agent: run on the Proxmox host and pick your Ollama LXC, or run inside it
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/agent.sh)"
```

Windows hosts: see [the Windows agent](#1b-install-the-agent-on-windows).

## Architecture

The Ollama HTTP API can't report GPU stats or change Ollama's own environment, so there are two pieces: a **dashboard** (Next.js, runs in Docker) and a small **agent** on every Ollama host. Both agents are single-file Node.js scripts with zero npm dependencies, and they speak the same HTTP API.

```mermaid
flowchart LR
    browser([Browser]) -->|":8080"| dash

    subgraph docker["Docker host"]
        dash["llama-paddock<br/>Next.js dashboard"]
    end

    subgraph lxc["Linux LXC / VM"]
        ol1["ollama.service<br/>:11434"]
        ag1["linux agent<br/>:11435 (systemd)"]
        ag1 -. "nvidia-smi · /proc<br/>override.conf · systemctl · journalctl" .-> ol1
    end

    subgraph win["Windows PC"]
        ol2["Ollama app<br/>:11434"]
        ag2["windows agent<br/>:11435 (task at logon)"]
        ag2 -. "nvidia-smi · tasklist<br/>user env vars · server.log" .-> ol2
    end

    dash -->|"Ollama API: ps, tags, show,<br/>pull, create, copy, delete"| ol1
    dash -->|"bearer token: stats,<br/>env, restart, logs"| ag1
    dash --> ol2
    dash --> ag2
```

| Piece | Runs where | Does what |
|---|---|---|
| **Dashboard** (`dashboard/`) | Docker container | Polls every instance (background poller started from `instrumentation.ts`), stores metric history and job state in SQLite in the data directory, serves the UI and a JSON API, runs pulls/creates as background jobs that survive a page refresh and a restart |
| **Linux agent** (`agent/linux/`) | Each Linux Ollama host, systemd service as root | Stats from `/proc` + `nvidia-smi`; edits `/etc/systemd/system/ollama.service.d/override.conf`, runs `daemon-reload` + `systemctl restart ollama`; tails `journalctl -u ollama` |
| **Windows agent** (`agent/windows/`) | Each Windows PC, Scheduled Task at logon in your session | Stats from Node/`tasklist`/`netstat` + `nvidia-smi`; edits your **user** environment variables (what Ollama for Windows reads); restarts the Ollama tray app with the new values; tails `%LOCALAPPDATA%\Ollama\server.log` |

An instance without an agent still gets `ollama ps` and full model management.

## 1a. Install the agent on Linux hosts

Run this **on the Proxmox host** or **inside the Ollama LXC/VM**:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/agent.sh)"
```

- **On a Proxmox host** it lists your containers, pre-selects the one with "ollama" in its name, and installs into it with `pct exec`.
- **Inside the container** it installs directly.

Either way it:
- installs Node.js if it's missing or older than 18.15 (distro package, falling back to NodeSource 22.x),
- installs the agent to `/opt/llama-paddock-agent` and enables `llama-paddock-agent.service`,
- writes `/etc/llama-paddock-agent.env` (mode 600) with a generated token,
- prints the Ollama URL, agent URL and agent token to enter under **Add host** in the dashboard.

Re-running it, or running `update-llama-paddock-agent` inside the container, updates the agent and **keeps the token**. To share one token across hosts, set `PADDOCK_AGENT_TOKEN=<token>` before the command. Running `bash install/agent.sh` from a clone of the repo uses the agent files in the clone.

**Uninstall:** run `uninstall-llama-paddock-agent` inside the container (or `pct exec <ctid> -- uninstall-llama-paddock-agent` from the host), or the one-liner with `PADDOCK_UNINSTALL=1`, which on a Proxmox host asks which container to remove it from. It removes the service, `/opt/llama-paddock-agent` and the token file. Ollama and the settings you made from the Environment tab stay, so Ollama keeps running as configured. Add `PADDOCK_YES=1` to skip the question.

The agent runs as root and can restart Ollama, so only the dashboard host should reach port 11435:

```bash
ufw allow from <dashboard-ip> to any port 11435 proto tcp
```

| Setting (`/etc/llama-paddock-agent.env`) | Default | Purpose |
|---|---|---|
| `PADDOCK_AGENT_TOKEN` | generated | Shared secret, required |
| `PADDOCK_AGENT_PORT` | `11435` | Listen port |
| `PADDOCK_OLLAMA_UNIT` | `ollama.service` | Unit to manage |
| `PADDOCK_OVERRIDE_PATH` | `/etc/systemd/system/ollama.service.d/override.conf` | Drop-in to edit (the file `systemctl edit ollama` writes) |
| `PADDOCK_DISK_PATHS` | empty | Extra mount points to report; `OLLAMA_MODELS` is added automatically |

## 1b. Install the agent on Windows

Prerequisite: Node.js 18.15 or newer (`winget install OpenJS.NodeJS.LTS`).

Copy `agent\windows\` to the PC and run the installer **from the account that runs Ollama**. Run it in an admin PowerShell if you want it to add the firewall rule:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -AllowFrom 192.168.30.0/24
```

The installer:
- copies the agent to `%LOCALAPPDATA%\llama-paddock-agent`,
- writes `agent.json` with a generated token, readable only by you, and prints the token,
- registers a Scheduled Task, `llama-paddock-agent`, that starts the agent hidden at logon and restarts it if it crashes,
- when elevated, adds an inbound firewall rule for TCP 11435 from `-AllowFrom` (default: local subnet) on Private/Domain networks.

`uninstall.ps1` removes all of it and leaves your Ollama variables as they are.

**Why a logon task instead of a Windows service?** Ollama for Windows is a tray app that runs in your session and reads your account's environment variables. The agent has to live in that same session to restart it correctly. The trade-off is that the agent, like Ollama itself, only runs while you're logged in.

**Ollama on Windows only listens on `localhost` by default.** Once the agent is up, set `OLLAMA_HOST` to `0.0.0.0:11434` in the dashboard's Environment tab. The agent restarts Ollama with it, and the dashboard can then reach the Ollama API.

The Windows agent only ever shows or changes Ollama-related variables (`OLLAMA_*`, `CUDA_*`, `HIP_*`, `GGML_*`, …) plus any custom ones you add through the dashboard. It refuses to touch `Path`, `TEMP` and other system variables.

## 2. Install the dashboard

### One-liner (recommended)

Run this **on the Proxmox host** to create a dedicated LXC, or **inside any Debian/Ubuntu LXC or VM** to install there:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/dashboard.sh)"
```

**On a Proxmox host** it opens a menu (whiptail dialogs, or plain text prompts without a terminal):

- **Default** shows a summary (Ubuntu LTS, next free CT ID, 2 cores, 1 GiB RAM, 6 GiB disk, DHCP on `vmbr0`, no root password) and creates the container when you choose **Create**.
- **Advanced** asks for every setting, then shows the same summary. **Change** goes back through the settings.
  - distribution: latest **Ubuntu LTS** or **Debian**,
  - CT ID, hostname, cores, RAM and disk,
  - storage and bridge, picked from what the node has,
  - VLAN tag, DHCP or a static IP (the gateway defaults to the first address of the subnet),
  - root password (blank means none, use `pct enter <ctid>` from the host),
  - root SSH login: `key` (default, key only), `password`, or `off`, plus an optional SSH public key file.

Every setting can be preset in the environment (`CT_OS`, `CT_ID`, `CT_HOSTNAME`, `CT_CORES`, `CT_RAM`, `CT_DISK`, `CT_STORAGE`, `CT_TSTORAGE`, `CT_BRIDGE`, `CT_VLAN`, `CT_IP`, `CT_GW`, `CT_PASSWORD`, `CT_ROOT_SSH`, `CT_SSH_KEY`). Add `PADDOCK_YES=1` to skip the menu entirely, or `PADDOCK_TUI=0` for text prompts instead of dialogs.

It then downloads the latest template for the distribution you pick (latest **Ubuntu LTS** by default, or **Debian**), creates an unprivileged container, and installs the dashboard inside it.

The container's **Notes** in the Proxmox UI get links to the dashboard (when it has a static IP), releases and issues. Logging in to the container shows a short banner with its version, OS, hostname, dashboard URL and status. Delete `/etc/profile.d/00_llama-paddock.sh` to turn the banner off.

**Inside a container or VM** it:
- installs Node.js 22 if needed,
- downloads the prebuilt dashboard from the latest GitHub release, or builds from `main` if there's no release yet,
- installs it to `/opt/llama-paddock` as the `llama-paddock` systemd service, running as an unprivileged user,
- writes `/etc/llama-paddock/config.yaml` and `/etc/llama-paddock/llama-paddock.env`, including a generated initial `admin` password,
- prints the URL and login.

Open the URL, sign in with the printed password, and choose your own password (required on first sign-in). Then use **Add host** to add your Ollama servers. Hosts added in the UI and the login are stored in `/var/lib/llama-paddock`.

Update with `update-llama-paddock` inside the container, or `pct exec <ctid> -- update-llama-paddock` from the host. Your config is kept.

### Prereleases

> [!WARNING]
> Prereleases are for testing. They are built from every change merged to `dev`, before it is released as stable, so features may be unfinished and there may be bugs, including ones that lose metric history or settings. The data format can change between prereleases, so going back to stable may mean waiting for the next stable release.

To try the newest prerelease (`vX.Y.Z-dev.N`), use the prerelease installer. It works like the one-liner above, with the same options, but shows this disclaimer and asks before installing:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/dev/install/dashboard-dev.sh)"
```

`update-llama-paddock` then stays on prereleases. To go back to stable, re-run the normal one-liner. With Docker, use the `:dev` image tag instead.

**Uninstall:**
- **Inside the container or VM:** `uninstall-llama-paddock` removes the service and `/opt/llama-paddock`. It asks whether to also delete the config, saved hosts and login (`/etc/llama-paddock`, `/var/lib/llama-paddock`); keep them and a reinstall picks them up again. Unattended: `PADDOCK_YES=1`, plus `PADDOCK_PURGE=1` to delete the data too.
- **On the Proxmox host:** run the one-liner with `PADDOCK_UNINSTALL=1`. The dashboard has its own container, so this **destroys that container**. Only containers tagged `llama-paddock` (set by the installer) are offered, and you confirm by typing the CT ID. Unattended: `PADDOCK_UNINSTALL=1 PADDOCK_YES=1 CT_ID=<ctid>`.

| Option | Default | |
|---|---|---|
| `PADDOCK_VERSION` | `latest` | a release tag (`v1.2.0`), or `source` to build `main` |
| `PADDOCK_PORT` | `8080` | |
| `PADDOCK_LOCAL=1` | | install on the Proxmox host itself instead of creating a CT |
| `PADDOCK_YES=1` | | non-interactive, accept defaults |

Example: `PADDOCK_VERSION=v0.1.0 bash -c "$(curl -fsSL …/install/dashboard.sh)"`.

### Docker

A multi-arch image is published to GHCR for every release:

```bash
cp .env.example .env    # initial dashboard login
docker compose up -d
```

Sign in at `http://<docker-host>:8080`, choose a new password, then **Add host**. Hosts, the login and metric history (`paddock.db`) are kept in the `paddock-data` volume (`/data`).

For the latest prerelease from the `dev` branch, use the `:dev` tag. To build the image yourself instead, swap `image:` for `build: ./dashboard` in `docker-compose.yml`. In an unprivileged LXC, Docker needs `nesting=1,keyctl=1`.

`config.yaml` is optional: mount it for `poll_interval`, `history_points` / `history_retention_days`, or to define hosts declaratively (those are read-only in the UI). It expands `${VAR}` from the environment, so tokens can stay in `.env`.

### Login

- `PADDOCK_USERNAME` / `PADDOCK_PASSWORD` set the **initial** login. The first sign-in requires choosing a new password, which is stored hashed (scrypt) in `auth.json` in the data directory. After that the env values are ignored.
- If `PADDOCK_PASSWORD` is empty, a random one is printed to the log on first start.
- Change it later from the account menu (top right). Changing it signs out other sessions. Five wrong attempts lock that address out for 5 minutes.
- **Forgot the password:** delete `auth.json` from the data directory (`/var/lib/llama-paddock`, or the Docker volume) and restart. The login is recreated from the env values.
- `PADDOCK_AUTH=off` disables the login, e.g. when a reverse proxy with auth already sits in front of it. `/api/healthz` stays open for health checks.

### From source

Requires Node 22.13 or newer (for the built-in `node:sqlite`):

```bash
cd dashboard
npm ci && npm run build
cp -r .next/static .next/standalone/.next/static
PADDOCK_DATA_DIR=../data PORT=8080 node .next/standalone/server.js
```

## Releases

Versions follow [SemVer](https://semver.org) and are released automatically by [semantic-release](https://github.com/semantic-release/semantic-release) from [Conventional Commits](https://www.conventionalcommits.org). See [CONTRIBUTING.md](CONTRIBUTING.md) for how to prefix commit messages.

| Commit / PR title | Bump while `0.x` |
|---|---|
| `fix: …`, `perf: …` | patch (`0.1.0` → `0.1.1`) |
| `feat: …` | minor (`0.1.0` → `0.2.0`) |
| `feat!: …` or a `BREAKING CHANGE:` footer | minor (`0.1.0` → `0.2.0`) |
| `chore:`, `docs:`, `ci:`, `refactor:`, `test:` … | none |

Every push to `main` or `dev` runs `.github/workflows/release.yml`. When there's something to release, it:
- bumps the version in `dashboard/package.json` and both agents, updates `CHANGELOG.md`, and tags `vX.Y.Z`,
- builds the dashboard once and attaches `llama-paddock-dashboard-vX.Y.Z.tar.gz` to the GitHub release (the one-line installer downloads this),
- attaches both agents and a `SHA256SUMS` file,
- builds the image natively on amd64 and arm64 runners and pushes it as one multi-arch tag.

| Branch | Version | GitHub release | Image tags |
|---|---|---|---|
| `main` | `vX.Y.Z` | release | `:X.Y.Z`, `:X.Y`, `:latest` |
| `dev` | `vX.Y.Z-dev.N` | prerelease | `:X.Y.Z-dev.N`, `:dev` |

Prereleases are never picked up by `latest`: the installer and the `:latest` image only follow `main`. To try one, use `PADDOCK_VERSION=vX.Y.Z-dev.N` with the installer or the `:dev` image.

The workflow only runs when `dashboard/`, `agent/` or the release config change, so docs-only pushes never build an image or cut a release. Dependabot (`.github/dependabot.yml`) opens weekly update PRs; runtime dependency and base-image bumps are titled `fix(deps): …` and ship as a patch release once merged.

Configuration lives in `.releaserc.json`. PR titles are checked by `.github/workflows/pr-title.yml`, since the squash-merge commit is what semantic-release reads.

## Using it

**Monitor tab:** loaded models (Unload button), one card per GPU with sparklines, and host CPU/RAM/disk/network. The processor bar on each loaded model shows the GPU vs CPU split. Anything below 100% GPU means the model plus its KV cache didn't fit in VRAM.

![Monitor tab](docs/images/monitor.png)

**Models tab:** pull by name (`qwen3:8b`, `gemma3:12b`, …). Progress shows in the Jobs drawer, and the list refreshes when a pull finishes.

![Pulling a model](docs/images/models-pull.png)

*Edit* opens the model editor:
- Context presets from 4K up to the model's native maximum (read from GGUF metadata), or type any `num_ctx`
- Add or remove any parameter (`temperature`, `top_p`, `num_gpu`, `stop`, …) and change the system prompt
- **Save as** defaults to a new name such as `hermes3:8b-ctx32k`. Ollama layers it on the original model, so no weights are duplicated. Using the original name overwrites it in place; a later `ollama pull` of a registry model resets that.

Under the hood this is `POST /api/create` with `from` and `parameters`, the API equivalent of a `FROM` + `PARAMETER` Modelfile.

![Model editor](docs/images/model-editor.png)

**Environment tab:** every common `OLLAMA_*` variable with a description, plus any custom variable. Variables set elsewhere are listed read-only, so you can see what you'd override: the main unit or another drop-in on Linux, system-wide variables on Windows.

- **Linux:** only the `Environment=` lines in `override.conf` are rewritten; other directives (`LimitNOFILE=`, `User=`, …) are kept. A timestamped `.bak` is written first (last 10 kept), then `daemon-reload` and a restart.
- **Windows:** the user variables are updated, then the Ollama app is stopped and relaunched with the new values.

![Environment tab](docs/images/environment.png)

![Environment tab on a Windows host](docs/images/environment-windows.png)

**Logs tab:** `journalctl -u ollama` on Linux, `server.log` on Windows, with optional auto-refresh. Errors and warnings are highlighted.

## API

Everything the UI does is plain JSON, so it can be scripted (n8n, Hermes, cron):

| Method | Path | |
|---|---|---|
| GET | `/api/instances` | all instances with latest stats + ps |
| GET | `/api/instances/{id}/history` | latest `history_points` polls; `?range=1h\|6h\|24h\|7d\|30d` for a downsampled range |
| GET | `/api/instances/{id}/models` | `ollama list` |
| POST | `/api/instances/{id}/models/show` | `{model}` → details, parsed params, native ctx |
| POST | `/api/instances/{id}/models/pull` | `{model}` → job |
| POST | `/api/instances/{id}/models/create` | `{model, from, parameters, system?}` → job |
| POST | `/api/instances/{id}/models/{load,unload,delete,copy}` | |
| GET / DELETE | `/api/jobs`, `/api/jobs/{id}` | job status / cancel |
| GET / PUT | `/api/instances/{id}/env` | `{vars, restart}` |
| POST | `/api/instances/{id}/restart` | restart Ollama |
| GET | `/api/instances/{id}/logs?lines=500` | log tail |

## Project layout

```
install/          dashboard.sh, agent.sh  (one-line installers)
agent/linux/      paddock-agent.mjs, systemd unit
agent/windows/    paddock-agent.mjs, install.ps1, uninstall.ps1
dashboard/        Next.js app (App Router, TypeScript)
  app/api/        route handlers (the JSON API above)
  lib/server.ts   poller, job runner, Ollama/agent clients
  components/     React UI
  lib/auth.ts     login, sessions (checked for every request by proxy.ts)
.github/workflows release.yml (semantic-release: tag, tarball, agents, GHCR image; main + dev)
docs/logo/        logo-mark.svg (app icon), banner-dark.svg / banner-light.svg (README header)
```

Development: `cd dashboard && npm install && PADDOCK_DATA_DIR=../data npm run dev`.

## Limitations

- The Linux agent assumes Ollama runs under systemd, as with the official install script. If Ollama runs in Docker, set its environment in compose instead. Monitoring and model management still work.
- The Windows agent targets the standard Ollama desktop install. If you run `ollama serve` as a Windows service (NSSM or similar), the agent can't manage that service's environment.
- On Windows with consumer GPUs, `nvidia-smi` doesn't report per-process VRAM (a WDDM limitation), so the process table is empty there.
- Removing a parameter in the model editor may not drop it from the derived model if Ollama inherits it from the base layer. To clear one, set it explicitly to the value you want.
