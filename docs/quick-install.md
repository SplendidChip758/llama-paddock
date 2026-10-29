# Quick install

Run these on a **Proxmox VE host**, or inside an existing LXC/VM:

```bash
# Dashboard: creates its own LXC when run on the Proxmox host
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/dashboard.sh)"

# Agent: run on the Proxmox host and pick your Ollama LXC, or run inside it
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/agent.sh)"
```

Windows hosts: see [the Windows agent](install/agent-windows.md).

What each installer does, and its options: [the dashboard](install/dashboard.md), [the Linux agent](install/agent-linux.md).
