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
  <a href="https://ollama.com"><img alt="Ollama" src="https://img.shields.io/badge/Ollama-compatible-1b1814?style=flat-square&logo=ollama&logoColor=white"></a>
  <a href="https://nextjs.org"><img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-1b1814?style=flat-square&logo=nextdotjs&logoColor=white"></a>
  <a href="docs/agent-linux.md"><img alt="Node.js" src="https://img.shields.io/badge/agent-Node.js%20%E2%89%A518.15-1b1814?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="docs/architecture.md"><img alt="Platforms" src="https://img.shields.io/badge/hosts-Linux%20%7C%20Windows-1b1814?style=flat-square"></a>
  <a href="docs/installation.md#docker"><img alt="Docker" src="https://img.shields.io/badge/dashboard-Docker-1b1814?style=flat-square&logo=docker&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://llama-paddock.com">Website</a> ·
  <a href="#quick-start">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="ROADMAP.md">Roadmap</a> ·
  <a href="https://github.com/SplendidChip758/llama-paddock/issues">Issues</a>
</p>

A self-hosted dashboard for monitoring and managing a fleet of Ollama hosts on Linux and Windows.

- **Monitor your fleet:** loaded models, GPU/CPU split, NVIDIA GPU stats, host CPU/RAM/disk/network, and charts of up to 30 days of history.
- **Manage models:** pull with live progress, load, unload, copy, delete, and edit parameters or system prompts.
- **Manage hosts:** edit Ollama's environment, restart it, and tail logs through a lightweight agent.

![Fleet overview](docs/images/overview.png)

The dashboard connects directly to Ollama for model management. Add the optional agent on each host for GPU/host stats and service controls. See [how it works](docs/architecture.md).

## Quick start

### Proxmox or Debian/Ubuntu

Run as root on a **Proxmox VE host** to create a dedicated dashboard LXC, or inside an existing **Debian/Ubuntu LXC or VM** to install there:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/dashboard.sh)"
```

Open the printed URL, sign in with the generated password, choose a new password, then **Add host** with your Ollama URL.

For GPU and host stats, environment editing, restarts and logs, install the agent on each Ollama host. On Linux, run this on the Proxmox host (it asks which container) or inside the Ollama LXC/VM:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/agent.sh)"
```

It prints the agent URL and token to enter under **Add host**. Details: [Linux agent](docs/agent-linux.md) · [Windows agent](docs/agent-windows.md).

### Docker

```bash
git clone https://github.com/SplendidChip758/llama-paddock.git
cd llama-paddock
cp .env.example .env
```

Edit `.env` to set your initial login, then run:

```bash
docker compose up -d
```

Open `http://<docker-host>:8080`, change the initial password, and **Add host**. The named data volume keeps hosts, login, history and job state across upgrades.

### Requirements

- **Ollama hosts:** Linux with Ollama as a systemd service (the official install script sets that up), or Windows with the Ollama desktop app. Hosts without the agent still get model management.
- **GPU stats:** NVIDIA, through `nvidia-smi`. AMD and Apple GPUs are [planned](ROADMAP.md#m6-platforms).
- **Dashboard:** Docker (amd64 or arm64), or Debian/Ubuntu, where the installer sets up Node.js 22.

Keep Ollama and the agents on a trusted network. The dashboard login does not protect direct access to their ports. See the [installation guide](docs/installation.md) for networking, requirements and source builds.

## Features

### See what each host is doing

The Monitor tab brings loaded models, NVIDIA GPU stats and host resources together. Check GPU utilization, VRAM, temperature and power alongside CPU, RAM, disk and network usage. Recent sparklines show how usage is changing, and each loaded model shows its context window, GPU/CPU split and unload timer.

![Monitor tab with loaded models, GPU metrics and host resources](docs/images/monitor.png)

### Look back over days and weeks

Below the live view, the History charts cover the last hour up to 30 days: GPU utilization, memory, temperature and power for each GPU, CPU, RAM, network, and the VRAM held by loaded models. History is stored on disk and survives restarts, and each host shows which Ollama and agent versions it runs.

### Pull and tune models

Pull models by name with live progress in the Jobs drawer, then load, unload, copy or delete them from the Models tab. The model editor lets you adjust context length, sampling parameters, stop sequences and the system prompt. Save a variation under a new name to keep the original model available.

![Model editor with context presets, parameters and system prompt](docs/images/model-editor.png)

### Manage Ollama settings

View and edit Ollama's environment variables with descriptions of common settings. The agent applies changes and restarts Ollama on Linux or Windows, while variables inherited from elsewhere remain visible. Use the Logs tab to inspect Ollama's output with highlighted errors and warnings.

![Environment tab with Ollama settings and restart controls](docs/images/environment.png)

See the [usage guide](docs/usage.md) for the full walkthrough, more screenshots and platform-specific details.

## Documentation

| I want to… | Guide |
|---|---|
| Install the dashboard or agents | [Dashboard](docs/installation.md) · [Linux agent](docs/agent-linux.md) · [Windows agent](docs/agent-windows.md) |
| Configure hosts, history or login | [Configuration](docs/configuration.md) |
| Monitor hosts and manage models | [Using the dashboard](docs/usage.md) |
| Update, back up, try prereleases or fix a problem | [Operations](docs/operations.md) |
| Automate tasks | [API reference](docs/api.md) |
| Understand the components | [Architecture](docs/architecture.md) |

## Project

llama-paddock is pre-1.0: upgrades are automatic, but settings and APIs can still change between 0.x releases ([versioning](ROADMAP.md#versioning)). See the [roadmap](ROADMAP.md) for planned work and [releases](https://github.com/SplendidChip758/llama-paddock/releases) for shipped changes. `:latest` follows stable releases; `:dev` follows prereleases. Read the [prerelease notes](docs/operations.md#prereleases) before switching.

Contributions are welcome—start with [Contributing](CONTRIBUTING.md). Report bugs and suggest features in [Issues](https://github.com/SplendidChip758/llama-paddock/issues); report vulnerabilities privately using the [security policy](SECURITY.md).

Licensed under [AGPL-3.0](LICENSE).
