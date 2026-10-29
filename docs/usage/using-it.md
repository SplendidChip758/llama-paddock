# Using llama-paddock

**Monitor tab:** loaded models (Unload button), one card per GPU with sparklines, and host CPU/RAM/disk/network. The processor bar on each loaded model shows the GPU vs CPU split. Anything below 100% GPU means the model plus its KV cache didn't fit in VRAM.

**History** (bottom of the Monitor tab): charts for the last 1h, 6h, 24h, 7d or 30d. GPU utilization, memory, temperature and power (one line per GPU), CPU, RAM, network, and the VRAM held by loaded models. Hover a chart for exact values. The longer ranges show 1-minute or 15-minute averages, and lines break where the host wasn't reachable.

**Versions:** the dashboard's version is next to the logo (highlighted for a prerelease). Each host shows its Ollama and agent version on its page and its overview card.

![Monitor tab](../images/monitor.png)

**Models tab:** pull by name (`qwen3:8b`, `gemma3:12b`, …). Progress shows in the Jobs drawer, and the list refreshes when a pull finishes.

![Pulling a model](../images/models-pull.png)

*Edit* opens the model editor:
- Context presets from 4K up to the model's native maximum (read from GGUF metadata), or type any `num_ctx`
- Add or remove any parameter (`temperature`, `top_p`, `num_gpu`, `stop`, …) and change the system prompt
- **Save as** defaults to a new name such as `hermes3:8b-ctx32k`. Ollama layers it on the original model, so no weights are duplicated. Using the original name overwrites it in place; a later `ollama pull` of a registry model resets that.

Under the hood this is `POST /api/create` with `from` and `parameters`, the API equivalent of a `FROM` + `PARAMETER` Modelfile.

![Model editor](../images/model-editor.png)

**Environment tab:** every common `OLLAMA_*` variable with a description, plus any custom variable. Variables set elsewhere are listed read-only, so you can see what you'd override: the main unit or another drop-in on Linux, system-wide variables on Windows.

- **Linux:** only the `Environment=` lines in `override.conf` are rewritten; other directives (`LimitNOFILE=`, `User=`, …) are kept. A timestamped `.bak` is written first (last 10 kept), then `daemon-reload` and a restart.
- **Windows:** the user variables are updated, then the Ollama app is stopped and relaunched with the new values.

![Environment tab](../images/environment.png)

![Environment tab on a Windows host](../images/environment-windows.png)

**Logs tab:** `journalctl -u ollama` on Linux, `server.log` on Windows, with optional auto-refresh. Errors and warnings are highlighted.
