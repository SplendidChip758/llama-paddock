# Install the agent on Windows

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
