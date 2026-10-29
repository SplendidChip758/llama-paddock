# Documentation

How to install, configure, use and script llama-paddock. Start with [installing the dashboard](installation.md), then add your Ollama hosts. The agent is optional for model management and needed for GPU and host stats, environment editing, restarts and logs.

<!-- The website builds its Docs section from this folder, and this page sets
its sidebar: each ## heading is a group, and each list item that links to a
page is an entry, in this order. Keep that format. -->

## Install

- [The dashboard](installation.md): Proxmox, Debian/Ubuntu, Docker, source builds and adding hosts
- [The agent on Linux](agent-linux.md): install, settings, firewall, updates and removal
- [The agent on Windows](agent-windows.md): the logon task, firewall, settings and updates

## Use

- [Using the dashboard](usage.md): Monitor and History, Models, Environment, Logs and jobs
- [Configuration and login](configuration.md): `config.yaml`, environment variables, login and the data directory
- [Operations](operations.md): updates, backups, prereleases, uninstalling and troubleshooting
- [Security](security.md): what a login can do, exposing the dashboard safely and reverse proxies

## Reference

- [API](api.md): the dashboard's JSON API and the agent API
- [Architecture](architecture.md): components, ports and source layout

For contributors: [contributing](../CONTRIBUTING.md), the [roadmap](../ROADMAP.md), [agent instructions](../AGENTS.md), the [security policy](../SECURITY.md) and the [Code of Conduct](../CODE_OF_CONDUCT.md).

These guides describe the branch you're viewing. For an installed release, read them at its Git tag.
