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
  <a href="docs/install/agent-linux.md"><img alt="Node.js" src="https://img.shields.io/badge/agent-Node.js%20%E2%89%A518.15-1b1814?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="docs/introduction.md#architecture"><img alt="Platforms" src="https://img.shields.io/badge/hosts-Linux%20%7C%20Windows-1b1814?style=flat-square"></a>
  <a href="docs/install/docker.md"><img alt="Docker" src="https://img.shields.io/badge/dashboard-Docker-1b1814?style=flat-square&logo=docker&logoColor=white"></a>
</p>

<p align="center">
  <a href="#quick-install">Install</a> ·
  <a href="docs/usage/using-it.md">Features</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="docs/reference/api.md">API</a> ·
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

Windows hosts: see [the Windows agent](docs/install/agent-windows.md). Docker, building from source and prereleases: see [Install the dashboard](docs/install/dashboard.md).

## Documentation

The full documentation is in [`docs/`](docs/README.md):

- **Getting started:** [Introduction and architecture](docs/introduction.md) · [Quick install](docs/quick-install.md)
- **Install:** [Dashboard](docs/install/dashboard.md) · [Agent on Linux](docs/install/agent-linux.md) · [Agent on Windows](docs/install/agent-windows.md) · [Docker](docs/install/docker.md) · [From source](docs/install/from-source.md) · [Prereleases](docs/install/prereleases.md)
- **Using it:** [Monitor and manage](docs/usage/using-it.md) · [Login](docs/usage/login.md)
- **Reference:** [API](docs/reference/api.md) · [Limitations](docs/reference/limitations.md)
- **Project:** [Releases](docs/project/releases.md) · [Project layout](docs/project/layout.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md)
