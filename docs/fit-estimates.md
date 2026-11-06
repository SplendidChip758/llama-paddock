# Fit estimates

Before you load a model at a bigger context, the dashboard estimates how much memory it will need and where it will sit on each host: fully in VRAM, partly on the CPU, or not at all. The estimate is in the [model editor](usage.md#models), under **Fit estimate**, and updates as you change `num_ctx`, `num_gpu` or `num_batch`.

An estimate is a prediction, not a measurement. It says how confident it is; the [API](#api) also lists what it assumed.

## What it shows

| Shown | Means |
|---|---|
| **likely fits** | The whole model is expected in VRAM, on one GPU or split across several |
| **likely CPU offload** | Part of it (or all, on a host without a GPU or with `num_gpu 0`) is expected in system RAM, where the CPU runs it, usually far slower. The chip shows the expected share in VRAM |
| **insufficient capacity** | The part that doesn't fit in VRAM doesn't fit in free system RAM either |
| **insufficient information** | Something the estimate needs isn't known: the model's metadata doesn't give its layer sizes (or, for a model that isn't pulled, couldn't be read from its registry), or the host has no agent, so its GPUs aren't known |
| **cloud** | An Ollama cloud model: it runs remotely and takes no memory on the host |

Below the verdict:

- The breakdown: **weights** (the model's files), **KV cache** (grows with the context), **buffers** (compute buffers) and the total, which is what `/api/ps` would report as the loaded model's `size`.
- **Largest context likely fully in VRAM**, with **use** to set it as `num_ctx`.
- The loaded models Ollama would unload first, when the model doesn't fit beside them. Ollama unloads idle models to make room, so this isn't a failure, but it means the models will push each other out ([reloads](context-and-reloads.md#reloads)).

The context is the editor's `num_ctx`, or else `OLLAMA_CONTEXT_LENGTH`, or else Ollama's default of 4,096, capped at what the model supports.

## How it's estimated

- **Weights**: the size of the model's files, from `/api/tags`, or from the registry for a model that isn't pulled (see below).
- **KV cache**: layers × KV heads × (key + value dimensions) × bytes per element × context × `OLLAMA_NUM_PARALLEL`, from the model's metadata in `/api/show`. Bytes per element are 2 for `f16`, about 1.06 for `q8_0` and 0.56 for `q4_0`. `OLLAMA_KV_CACHE_TYPE` only applies with flash attention on, as in Ollama. Layers with sliding-window attention (Gemma 2 and 3, gpt-oss, Command R7B) keep only their window.
- **Buffers**: after Ollama's own estimate, the larger of the activations and the output logits for a batch, plus the attention scores over the whole context when flash attention is off.
- **Placement**: each GPU's memory, less about 457 MiB that Ollama keeps free, `OLLAMA_GPU_OVERHEAD` and VRAM held by other processes. A model that fits on one GPU goes there. One that doesn't is spread across several, each with its own buffers, so GPUs don't add up to one pooled device. Otherwise Ollama offloads whole layers, and the rest must fit in system RAM (counting what Ollama's runners hold, since it unloads models to make room).

## Calibration

Every time the dashboard sees a model loaded, it records the size `/api/ps` reports, with the context and the settings that change it (`OLLAMA_KV_CACHE_TYPE`, `OLLAMA_FLASH_ATTENTION`, `OLLAMA_NUM_PARALLEL`). These are kept in `paddock.db` and survive restarts. An estimate under the same settings uses them:

| Calibration | Used when |
|---|---|
| **measured** | The model was seen at exactly this context: the reported size is the estimate |
| **calibrated** (fitted) | It was seen at two or more contexts: a line through them, since memory grows linearly with the context |
| **calibrated** (offset) | It was seen at one other context: the formula, shifted by how far it was off there |

Measurements from the host itself come first. Without any, measurements from other hosts with the same settings are used.

## Models that aren't pulled

A model the host doesn't have, such as `qwen3:8b` or `hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M`, is read from an allowed registry source instead: the manifest gives the exact size of its files, and the first few MB of its weights give the GGUF metadata the KV cache formula needs. Nothing is downloaded to the host. The manifest's digest is the one Ollama reports once the model is pulled, so measurements from hosts that have it loaded still [calibrate](#calibration) the estimate.

Names without a host resolve to the Ollama registry (`model_registry_url`, `https://registry.ollama.ai` by default). Host-prefixed names are only supported for explicit allowlisted hosts (`hf.co` and `huggingface.co` for Hugging Face); other hosts are rejected. Manifests are cached for an hour, metadata for as long as the dashboard runs. `model_library: false` in [`config.yaml`](configuration.md) stops these requests: the estimate then needs the model pulled on the host.

The API's `source` says which it was: `host` or `registry`.

## Confidence

- **high**: measured at this context, or calibrated between measured contexts.
- **medium**: the formula with the host's settings known, or calibration extrapolated beyond the measured contexts.
- **low**: the formula with settings guessed (no agent, or `OLLAMA_FLASH_ATTENTION` not set), a model with recurrent layers or sliding-window layers the dashboard can't place, or an estimate within 5% of the available memory.

A model split across several GPUs is one step less confident.

## Limits

- **Flash attention.** With `OLLAMA_FLASH_ATTENTION` unset, the estimate assumes it is off. Recent Ollama versions turn it on by themselves for some models and GPUs, so the real size can be well below the estimate at large contexts. Set it explicitly on the [Environment](usage.md#environment) tab for a better estimate, or load the model once to calibrate.
- **Default context.** Some Ollama versions choose the default context by free VRAM, not 4,096.
- **Non-NVIDIA GPUs.** The agent reads GPUs through `nvidia-smi`, so other GPUs show as no GPU.

## API

`POST /api/instances/{id}/models/fit` with `{model, num_ctx?}` returns the estimate for every host (this one first, others as if the model were pulled there), each with the assumptions behind it, along with the inputs: the model's metadata, each host's GPUs, RAM and settings, and the recorded measurements. See [the API](api.md#models-and-jobs).
