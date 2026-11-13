# Windows agent

The Windows agent runs on a Windows PC next to the Ollama desktop app and adds GPU and host stats, environment editing, restarts, logs and the [GPU check](gpu-check.md).

It runs as a Windows service, so it reports the PC from startup, and leaves Ollama running as it does: the Ollama desktop app, in the session of the user who runs it. A small tray app in that session restarts Ollama and applies new settings for the service. Nothing needs installing first: the setup includes the .NET runtime.

The Windows agent has its own repository, [llama-paddock-win-agent](https://github.com/SplendidChip758/llama-paddock-win-agent), and its own releases, apart from the dashboard and the Linux agent.

## Install

Download `llama-paddock-agent-setup.exe` from the [latest Windows agent release](https://github.com/SplendidChip758/llama-paddock-win-agent/releases/latest) and run it. It needs an administrator. For a prerelease, download it from that release on the releases page instead. The release's `SHA256SUMS` lists the setup's checksum, which `Get-FileHash llama-paddock-agent-setup.exe` shows.

The setup asks:

- **Who runs Ollama on this PC.** It suggests the user running Ollama now, or the only one with it installed. The agent reads that user's Ollama log, models and environment variables.
- **The agent port and the addresses to allow** (default: TCP 11435 from `LocalSubnet`), for a Windows Firewall rule on Private and Domain networks.

It then:

- installs the agent to `C:\Program Files\llama-paddock-agent` and registers the `llama-paddock-agent` service, which starts with Windows and restarts after a failure,
- writes `%ProgramData%\llama-paddock-agent\agent.json` with a generated token; the folder is readable only by SYSTEM and administrators,
- registers the tray app to start when anyone signs in, adds it to the Start menu as **llama-paddock agent**, and starts it for you,
- shows the agent URL, the token and the fingerprint of the agent's HTTPS key. Enter them under **Add host**, with the `https://` URL; see [encrypted agent connections](security.md#encrypted-agent-connections). The token isn't shown again.

**Over the earlier Node.js agent** (a scheduled task), the setup keeps its token, HTTPS key and settings and removes the task once the service answers, so the dashboard needs no change. If the service doesn't start, the Node.js agent is started again.

**Ollama on Windows only listens on `localhost` by default.** Once the agent is up, set `OLLAMA_HOST` to `0.0.0.0:11434` in the dashboard's Environment tab. The agent restarts Ollama with it. Also allow TCP 11434 from the dashboard host through Windows Firewall; the setup opens only the agent's port.

### Silent install

```powershell
.\llama-paddock-agent-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /OLLAMAUSER=<user> /ALLOWFROM=192.168.30.0/24 /LOG=setup.log
```

| Option | Default | Purpose |
|---|---|---|
| `/OLLAMAUSER=` | the user running Ollama, or the only one with it installed | The account that runs Ollama: `name`, `DOMAIN\name` or a SID. Needed when Ollama is installed for several users |
| `/PORT=` | `11435` | The agent port, for a new install |
| `/ALLOWFROM=` | `LocalSubnet` | The firewall rule's remote addresses, for a new install |
| `/NOFIREWALL=1` | | Don't add the firewall rule |

A silent install that couldn't start the agent exits with code 1; the reason is in the log. A new install's token is in `agent.json`.

### Uninstall

Remove **llama-paddock agent** in **Settings > Apps**. It asks whether to keep the token and the HTTPS key, so a later install is the same host to the dashboard. Silently: `"C:\Program Files\llama-paddock-agent\unins000.exe" /VERYSILENT`, with `/KEEPDATA=1` to keep them. Your Ollama variables are left as they are.

## How it works with Ollama

Ollama for Windows is a tray app that runs in its user's session and reads that user's environment variables. The service runs as SYSTEM, outside that session. It reads the user's files and variables directly, and asks the agent's tray app in the session for the rest: starting Ollama again and telling Windows the variables changed. They talk over a named pipe that only that user and SYSTEM can open, and the tray app serves only the service.

- **The PC is on and the user is signed in** (the screen may be locked): everything works.
- **The user isn't signed in:** stats, logs and the GPU check still work, and Ollama shows as stopped, as it is. Reading the environment answers "the Ollama user isn't signed in": Windows only loads a user's variables while they're signed in.
- **The tray app isn't running** (closed from its menu, or the user signed in before the agent was installed): saving environment variables and restarting Ollama answer "sign in on the PC: Ollama runs in your session", and change nothing. Start **llama-paddock agent** from the Start menu, or sign in again.

The Windows agent only ever shows Ollama-related variables (`OLLAMA_*`, `CUDA_*`, `HIP_*`, `GGML_*`, …) plus any custom ones you add through the dashboard, and only lets the dashboard change the ones on its [allowlist](usage.md#environment). It refuses to touch `Path`, `TEMP` and other system variables.

## Settings and updates

Settings live in `%ProgramData%\llama-paddock-agent\agent.json`, which only administrators can edit. Restart the service after a change (`Restart-Service llama-paddock-agent` in an admin PowerShell). Environment variables override values in this file.

| Setting | Default | Purpose |
|---|---|---|
| `PADDOCK_AGENT_TOKEN` | generated by the setup | Required shared secret |
| `PADDOCK_AGENT_BIND` | `0.0.0.0` | Listen address |
| `PADDOCK_AGENT_PORT` | `11435` | Listen port, for HTTPS and plain HTTP. If you change it, change the firewall rule `llama-paddock agent` too |
| `PADDOCK_AGENT_HTTP` | `on`; new installs write `off` | `off` serves HTTPS only. Updated agents keep plain HTTP on until the dashboard uses `https://` |
| `PADDOCK_AGENT_TLS_KEY` | `agent.key` next to `agent.json` | The agent's private key; created on first start if missing |
| `PADDOCK_AGENT_TLS_CERT` | `agent.crt` next to `agent.json` | Its certificate; made from the key if missing |
| `PADDOCK_OLLAMA_USER_SID` | set by the setup | The account (SID) that runs Ollama. Run the setup again with `/OLLAMAUSER=` to change it |
| `PADDOCK_OLLAMA_APP` | the Ollama user's `%LOCALAPPDATA%\Programs\Ollama\ollama app.exe` | Ollama desktop executable. Without it, the agent restarts Ollama as `ollama.exe serve` from the same folder |
| `PADDOCK_DISK_PATHS` | empty | Extra drives or folders to report, comma-separated |
| `PADDOCK_AGENT_ENV_ALLOW` | empty | Extra variables the dashboard may set, comma-separated; a trailing `*` allows a prefix (`HSA_*,MY_VAR`). See [Environment](usage.md#environment) |

The agent logs to `%ProgramData%\llama-paddock-agent\logs\agent.log`.

To replace the agent's HTTPS key, stop the service, delete `agent.key` and `agent.crt` and start it again; the dashboard then shows that the key changed, and you accept the new one there after comparing it with the fingerprint in `agent.log`.

The dashboard flags a Windows agent older than the latest [release](https://github.com/SplendidChip758/llama-paddock-win-agent/releases), but can't update it yet. To update, run the newer release's setup: it keeps the token, the HTTPS key and the settings.

The agent targets the standard Ollama desktop install, not an `ollama serve` process managed by NSSM or another Windows service wrapper. See [Troubleshooting](operations.md#troubleshooting) for firewall and GPU limitations.

## The earlier Node.js agent

Earlier releases had a Node.js agent instead, in `llama-paddock-agent-windows.zip`. Its `install.ps1` ran it as a scheduled task at logon in your session, from `%LOCALAPPDATA%\llama-paddock-agent`, and needed Node.js 18.15 or newer. It speaks the same API, so the dashboard works with both. To move to the service, run the setup: it takes over the token, the HTTPS key and the settings. To remove the Node.js agent without the setup, run its `uninstall.ps1`.
