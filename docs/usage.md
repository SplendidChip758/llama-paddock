# Use the dashboard

A tour of the dashboard: monitor hosts and their history, manage models, edit Ollama's environment and read its logs. [Alerts](alerts.md) have a page of their own.

## Fleet overview

The home page has one card per host: status, versions, CPU and RAM, and each GPU's utilization and VRAM. Each loaded model is a chip with its GPU/CPU split, such as `qwen3:32b · 62% GPU` (see [GPU/CPU split](#gpucpu-split)). A model that isn't fully on the GPU gets a warning chip and is named under the chips, and the **Models loaded** total counts how many models fleet-wide aren't fully on the GPU.

A host with [alerts](alerts.md) firing gets a red **N alerts** badge that opens its alert history; silenced and acknowledged alerts don't count. **Availability (30d)** is the share of the last 30 days that Ollama and the agent were up, counting only the time the dashboard was watching (see [Monitor](#monitor)).

## Monitor

The Monitor tab shows loaded models (context window, unload timer and an Unload button), one card per GPU (utilization, VRAM, temperature, power, clocks, PCIe link and per-process VRAM, with sparklines), and host CPU per core, RAM, disks including `OLLAMA_MODELS`, network, and Ollama's memory and runner count. The Processor column on each loaded model shows its [GPU/CPU split](#gpucpu-split) in Ollama's own wording (`38% CPU / 62% GPU`) with a bar and the VRAM it holds. A model that isn't fully on the GPU has a **Not fully on the GPU: why?** note that opens to the likely causes.

**History**, at the bottom of the tab, charts the last 1h, 6h, 24h, 7d or 30d: GPU utilization, memory, temperature and power (one line per GPU), CPU, RAM, network in/out, and the VRAM held by loaded models. Hover a chart for exact values. The 6h and 24h ranges show 1-minute averages and 7d and 30d 15-minute averages, and lines break where the host wasn't reachable. The chosen range is remembered in your browser.

**Availability**, below History, shows timelines of Ollama and the agent over the last 24 hours, 7 days or 30 days: up, down, or not yet seen after the dashboard started watching, with stretches the dashboard wasn't running or polling hatched. Each line shows the share of the watched time it was up; unwatched time doesn't count either way, so restarting the dashboard never lowers a host's availability. Below them is the list of outages with when they started, how long they lasted, and the error the poll got. Hover the timeline for the times of each stretch.

**Alerts** on the host are listed above the tabs, where they can be acknowledged or silenced, and **Silence host for…** next to **Edit host** silences every alert on the host for a while, for maintenance. See [Silences](alerts.md#silences).

**Versions:** the dashboard's version is shown next to the logo, highlighted for a prerelease. Each host shows its Ollama and agent version on its page and its overview card.

![Monitor tab](images/monitor.png)

## Models

Pull by name (`qwen3:8b`, `gemma3:12b`, …). Progress shows in the Jobs drawer, and the list refreshes when a pull finishes.

A loaded model shows a `loaded` chip with its [GPU/CPU split](#gpucpu-split), such as `loaded · 100% GPU`. Ollama cloud models (`gpt-oss:120b-cloud`, `gemma4:cloud`, …) get a dashed **cloud** badge, and no size, since they take no space on the host.

![Pulling a model](images/models-pull.png)

*Edit* opens the model editor:

- Context presets from 4K up to the model's native maximum (read from GGUF metadata), or type any `num_ctx`
- Add or remove any parameter (`temperature`, `top_p`, `num_gpu`, `stop`, …) and change the system prompt
- **Save as** defaults to a new name such as `hermes3:8b-ctx32k`. Ollama layers it on the original model, so no weights are duplicated. Using the original name overwrites it in place; a later `ollama pull` of a registry model resets that.

Under the hood this calls Ollama's `POST /api/create` with `from` and `parameters`, the API equivalent of a `FROM` + `PARAMETER` Modelfile.

![Model editor](images/model-editor.png)

## GPU/CPU split

Ollama keeps as much of a loaded model as fits in VRAM and puts the rest in system RAM, where the CPU runs it, usually far slower. The dashboard works out the split from Ollama's `/api/ps` (`size_vram` out of `size`, which includes the KV cache for the model's context) the same way on every page:

| Shown | Means |
|---|---|
| `100% GPU` | the whole model is in VRAM |
| `62% GPU` (warning style) | 38% is in system RAM and runs on the CPU |
| `100% CPU` (warning style) | nothing is in VRAM |
| `split unknown` | Ollama didn't report usable sizes, so the dashboard doesn't guess |
| `cloud` | an Ollama cloud model: it runs on Ollama's servers, not on the host |

Warnings are a hint, not an error: a host without a supported GPU, or a model deliberately split to fit a large context, is a valid setup. When it isn't intended, the usual causes are:

- **The context is too large.** The KV cache grows with `num_ctx`. Try a smaller context in the [model editor](#models), or a smaller quantization.
- **Other models are holding VRAM.** Unload them on the Monitor tab, or lower `OLLAMA_MAX_LOADED_MODELS` on the [Environment](#environment) tab.
- **`num_gpu` limits the GPU layers.** `num_gpu 0` keeps every layer on the CPU. Check the model's parameters in the model editor.
- **Ollama didn't find the GPU.** Check the [Logs](#logs) tab for the GPU it detected at startup.

**Cloud models** are marked wherever models are listed, since prompts sent to them leave your network. They take no local VRAM, so they never count towards a host's split.

The [hosts API](api.md#hosts) returns the same result as a `split` object on each loaded model.

## Environment

The Environment tab shows every common `OLLAMA_*` variable with a description, plus any custom variable. Variables set elsewhere are listed read-only, so you can see what you'd override: the main unit or another drop-in on Linux, system-wide variables on Windows.

- **Linux:** only the `Environment=` lines in `override.conf` are rewritten; other directives (`LimitNOFILE=`, `User=`, …) are kept. A timestamped `.bak` is written first (last 10 kept), then `daemon-reload` and a restart.
- **Windows:** the user variables are updated, then the Ollama app is stopped and relaunched with the new values.

When scripting environment changes, send the complete managed variable map: omitted variables on the allowlist are removed. The dashboard editor sends this full map for you. See the [API example](api.md#preserve-existing-environment-settings) to preserve existing settings.

Only variables Ollama and its GPU runtimes read can be set from the dashboard: `OLLAMA_*`, `CUDA_VISIBLE_DEVICES`, `CUDA_DEVICE_ORDER`, `HIP_VISIBLE_DEVICES`, `ROCR_VISIBLE_DEVICES`, `GPU_DEVICE_ORDINAL`, `HSA_OVERRIDE_GFX_VERSION`, `GGML_CUDA_ENABLE_UNIFIED_MEMORY` and the `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` variables. Other names, such as `LD_PRELOAD`, could load code into Ollama, so a dashboard login must not be enough to set them. To manage another variable from the dashboard, add it to `PADDOCK_AGENT_ENV_ALLOW` in the agent's settings on that host ([Linux](agent-linux.md), [Windows](agent-windows.md#settings-and-updates)). A variable that is already set but not on the list is shown read-only and left as it is when you save.

![Environment tab](images/environment.png)

![Environment tab on a Windows host](images/environment-windows.png)

## Logs

The Logs tab tails `journalctl -u ollama` on Linux, `server.log` on Windows, with optional auto-refresh. Errors and warnings are highlighted.

## History and jobs

Metric history and job state are stored in `paddock.db` in the [data directory](configuration.md#data-directory). The Monitor tab's sparklines show the last `history_points` polls and its History charts the longer ranges; the same data is available through the [history API](api.md#history). The dashboard also records when Ollama and the agent go down or come back and when models are loaded or unloaded, along with the times it wasn't watching, through the [events API](api.md#events).

Alert rules are checked against every poll; see [Alerts](alerts.md).

Pulls and model creation run in the background and stay visible in the Jobs drawer across page refreshes. After a dashboard restart, running pulls resume if their host still exists. Running creates are marked interrupted; check the model list before trying again.

Removing a parameter in the model editor may not remove a value inherited from the base model. Set it explicitly to the value you want.
