# Install the agent on Linux

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
- if Ollama only listens on localhost (no `OLLAMA_HOST`), asks whether other machines may reach it, and if so sets `OLLAMA_HOST=0.0.0.0` the same way the Environment tab does. Ollama's API has no login, so only say yes on a network you trust. On a Proxmox host the question is asked before installing into the container. Unattended runs and `update-llama-paddock-agent` never change it unless you set `PADDOCK_OLLAMA_REMOTE=1`,
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
