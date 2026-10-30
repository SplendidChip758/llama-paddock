# Use the dashboard

A tour of the dashboard: monitor hosts and their history, manage models, edit Ollama's environment and read its logs.

## Monitor

The Monitor tab shows loaded models (context window, unload timer and an Unload button), one card per GPU (utilization, VRAM, temperature, power, clocks, PCIe link and per-process VRAM, with sparklines), and host CPU per core, RAM, disks including `OLLAMA_MODELS`, network, and Ollama's memory and runner count. The processor bar on each loaded model shows the GPU vs CPU split. A split below 100% GPU means some of the model is running on the CPU; check available VRAM, context length and GPU-offload settings.

**History**, at the bottom of the tab, charts the last 1h, 6h, 24h, 7d or 30d: GPU utilization, memory, temperature and power (one line per GPU), CPU, RAM, network in/out, and the VRAM held by loaded models. Hover a chart for exact values. The 6h and 24h ranges show 1-minute averages and 7d and 30d 15-minute averages, and lines break where the host wasn't reachable. The chosen range is remembered in your browser.

**Versions:** the dashboard's version is shown next to the logo, highlighted for a prerelease. Each host shows its Ollama and agent version on its page and its overview card.

![Monitor tab](images/monitor.png)

## Models

Pull by name (`qwen3:8b`, `gemma3:12b`, …). Progress shows in the Jobs drawer, and the list refreshes when a pull finishes.

![Pulling a model](images/models-pull.png)

*Edit* opens the model editor:

- Context presets from 4K up to the model's native maximum (read from GGUF metadata), or type any `num_ctx`
- Add or remove any parameter (`temperature`, `top_p`, `num_gpu`, `stop`, …) and change the system prompt
- **Save as** defaults to a new name such as `hermes3:8b-ctx32k`. Ollama layers it on the original model, so no weights are duplicated. Using the original name overwrites it in place; a later `ollama pull` of a registry model resets that.

Under the hood this calls Ollama's `POST /api/create` with `from` and `parameters`, the API equivalent of a `FROM` + `PARAMETER` Modelfile.

![Model editor](images/model-editor.png)

## Environment

The Environment tab shows every common `OLLAMA_*` variable with a description, plus any custom variable. Variables set elsewhere are listed read-only, so you can see what you'd override: the main unit or another drop-in on Linux, system-wide variables on Windows.

- **Linux:** only the `Environment=` lines in `override.conf` are rewritten; other directives (`LimitNOFILE=`, `User=`, …) are kept. A timestamped `.bak` is written first (last 10 kept), then `daemon-reload` and a restart.
- **Windows:** the user variables are updated, then the Ollama app is stopped and relaunched with the new values.

Only variables Ollama and its GPU runtimes read can be set from the dashboard: `OLLAMA_*`, `CUDA_VISIBLE_DEVICES`, `CUDA_DEVICE_ORDER`, `HIP_VISIBLE_DEVICES`, `ROCR_VISIBLE_DEVICES`, `GPU_DEVICE_ORDINAL`, `HSA_OVERRIDE_GFX_VERSION`, `GGML_CUDA_ENABLE_UNIFIED_MEMORY` and the `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` variables. Other names, such as `LD_PRELOAD`, could load code into Ollama, so a dashboard login must not be enough to set them. To manage another variable from the dashboard, add it to `PADDOCK_AGENT_ENV_ALLOW` in the agent's settings on that host ([Linux](agent-linux.md), [Windows](agent-windows.md#settings-and-updates)). A variable that is already set but not on the list is shown read-only and left as it is when you save.

![Environment tab](images/environment.png)

![Environment tab on a Windows host](images/environment-windows.png)

## Logs

The Logs tab tails `journalctl -u ollama` on Linux, `server.log` on Windows, with optional auto-refresh. Errors and warnings are highlighted.

## History and jobs

Metric history and job state are stored in `paddock.db` in the [data directory](configuration.md#data-directory). The Monitor tab's sparklines show the last `history_points` polls and its History charts the longer ranges; the same data is available through the [history API](api.md#history).

Pulls and model creation run in the background and stay visible in the Jobs drawer across page refreshes. After a dashboard restart, running pulls resume if their host still exists. Running creates are marked interrupted; check the model list before trying again.

Removing a parameter in the model editor may not remove a value inherited from the base model. Set it explicitly to the value you want.
