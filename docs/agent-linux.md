# Linux agent

The Linux agent runs next to Ollama as a systemd service and adds GPU and host stats, environment editing, restarts and logs.

Run as root **on the Proxmox host** or **inside the Ollama LXC/VM**:

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
- prints the Ollama URL, agent URL, agent token and key fingerprint to enter under **Add host** in the dashboard.

Re-running it, or running `update-llama-paddock-agent` inside the container, updates the agent and **keeps the token and the key**. On a fresh install, set `PADDOCK_AGENT_TOKEN=<token>` before the command to supply your own token. Existing installations keep their token. Running `bash install/agent.sh` from a clone of the repo uses the agent files in the clone.

**Uninstall:** run `uninstall-llama-paddock-agent` inside the container (or `pct exec <ctid> -- uninstall-llama-paddock-agent` from the host), or the one-liner with `PADDOCK_UNINSTALL=1`, which on a Proxmox host asks which container to remove it from. It removes the service, `/opt/llama-paddock-agent`, the token file and the agent's key. Ollama and the settings you made from the Environment tab stay, so Ollama keeps running as configured. Add `PADDOCK_YES=1` to skip the question.

The agent runs as root and can restart Ollama, so restrict port 11435 to the dashboard host. For example, if UFW already denies other inbound traffic and the dashboard is at `192.168.30.100`:

```bash
ufw allow from 192.168.30.100 to any port 11435 proto tcp
```

| Setting (`/etc/llama-paddock-agent.env`) | Default | Purpose |
|---|---|---|
| `PADDOCK_AGENT_TOKEN` | generated | Shared secret, required |
| `PADDOCK_AGENT_BIND` | `0.0.0.0` | Listen address |
| `PADDOCK_AGENT_PORT` | `11435` | Listen port, for HTTPS and plain HTTP |
| `PADDOCK_AGENT_HTTP` | `on`; new installs write `off` | `off` serves HTTPS only. See [HTTPS](#https) |
| `PADDOCK_AGENT_TLS_KEY` | `/etc/llama-paddock-agent.key` | The agent's private key; created on first start if missing |
| `PADDOCK_AGENT_TLS_CERT` | `/etc/llama-paddock-agent.crt` | Its certificate; made from the key if missing |
| `PADDOCK_OLLAMA_UNIT` | `ollama.service` | Unit to manage |
| `PADDOCK_OVERRIDE_PATH` | `/etc/systemd/system/ollama.service.d/override.conf` | Drop-in to edit (the file `systemctl edit ollama` writes) |
| `PADDOCK_DISK_PATHS` | empty | Extra mount points to report; `OLLAMA_MODELS` is added automatically |
| `PADDOCK_AGENT_ENV_ALLOW` | empty | Extra variables the dashboard may set, comma separated; a trailing `*` allows a prefix (`HSA_*,MY_VAR`). See [Environment](usage.md#environment) |

After changing the agent settings, run `systemctl restart llama-paddock-agent`.

## HTTPS

The agent serves HTTPS on its port with its own key, created on first start, and a self-signed certificate. The installer prints the key's fingerprint (`SHA256:…`): enter it under **Agent key fingerprint** in Add host, with an `https://` agent URL. The dashboard then only talks to an agent with that key; see [encrypted agent connections](security.md#encrypted-agent-connections). The fingerprint is the same as `openssl x509 -in /etc/llama-paddock-agent.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`, without the trailing `=`.

- **New installs** serve HTTPS only: the installer writes `PADDOCK_AGENT_HTTP=off`. Plain HTTP requests get a 426 error.
- **Updates** keep plain HTTP on as well, on the same port, so the dashboard keeps working while its hosts still use `http://` agent URLs. The dashboard offers to switch them to `https://`. After that, set `PADDOCK_AGENT_HTTP=off` and restart the agent.
- **Replace the key** by re-running the installer with `PADDOCK_AGENT_NEW_KEY=1`, e.g. if the old one may have leaked. The dashboard then shows that the agent's key has changed: compare it with the fingerprint the installer printed and accept it.
- **Your own key and certificate**, e.g. from your own CA: point `PADDOCK_AGENT_TLS_KEY` and `PADDOCK_AGENT_TLS_CERT` at them. The dashboard still pins the key, not the CA. `PADDOCK_AGENT_NEW_KEY=1` leaves your own files alone.

If the agent can't create or read its key, it logs why and serves plain HTTP only, or doesn't start when `PADDOCK_AGENT_HTTP=off`.

The Linux agent manages a systemd Ollama service. For Ollama in Docker, configure its environment in Compose; model management through the Ollama API still works. See [Troubleshooting](operations.md#troubleshooting) for connection and GPU issues.
