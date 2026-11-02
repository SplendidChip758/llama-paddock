# GPU check

When Ollama can't use the GPU, it falls back to the CPU without an error. `nvidia-smi` still shows the GPU, so everything looks fine until models get slow. The GPU check compares where Ollama puts the loaded models with what `nvidia-smi` sees, reads Ollama's log for the reason, and suggests a fix.

It needs the [Linux](agent-linux.md) or [Windows](agent-windows.md) agent and an NVIDIA GPU. The result is shown on the host's **Monitor** tab, above the GPU cards, and a host whose GPU is lost gets a **GPU lost** chip on the fleet overview.

## What it checks

On every poll, the dashboard looks at Ollama's `/api/ps` and the agent's `nvidia-smi` readings. When Ollama restarts, or a model loads entirely on the CPU, it also reads:

- **Ollama's log since it last started**, but only the lines about GPUs: the GPU discovery at startup, CUDA and ROCm errors, and models loaded with no layers on the GPU. On Linux this is the journal of the current run of `ollama.service`; on Windows, `server.log`. Request lines, prompts and responses are not read.
- **Ollama's environment**, as on the [Environment](usage.md#environment) tab.
- **The Modelfile of each model on the CPU**, for `num_gpu`.
- **On Linux, the `nvidia_uvm` kernel module and `/dev/nvidia-uvm`**, which CUDA needs.

**Check again** reads all of this at once.

| Result | Means |
|---|---|
| **uses the GPU** | A loaded model is at least partly in VRAM, or nothing is loaded and Ollama found the GPU when it started |
| **GPU lost** | `nvidia-smi` sees a GPU, but every loaded model runs entirely on the CPU, or nothing is loaded and Ollama's log shows it found no GPU or hit GPU errors since it last found one |
| **CPU on purpose** | The models are on the CPU because a setting asks for it: `CUDA_VISIBLE_DEVICES=-1`, `OLLAMA_LLM_LIBRARY=cpu…`, or `num_gpu 0` in the Modelfile of every model on the CPU |
| **not known yet** | Nothing is loaded, and Ollama's log doesn't say whether it found the GPU. Load a model to check |

A model split between the GPU and the CPU is not a lost GPU: see [GPU/CPU split](usage.md#gpucpu-split) for that. Hosts without an NVIDIA GPU, or without an agent, show no check. A reading that's missing, such as `nvidia-smi` failing or the agent being down, never counts as a lost GPU.

## Causes and fixes

When the GPU is lost, the check lists the likely causes it found evidence for, likeliest first, and the fixes for them. **Restart Ollama** is always offered, since Ollama looks for GPUs again when it starts. Restarting unloads every model.

| Evidence | Likely cause | Fix |
|---|---|---|
| CUDA error 999 in Ollama's log | A suspend and resume: on Linux, `nvidia_uvm` has lost the device | **Reload nvidia_uvm and restart Ollama**. On Windows, restart Ollama or the PC |
| `nvidia_uvm` not loaded | CUDA can't start without it | **Reload nvidia_uvm and restart Ollama**, or `modprobe nvidia_uvm && nvidia-modprobe -u -c=0` |
| `/dev/nvidia-uvm` missing in a container | The Proxmox host creates the device when something first uses CUDA there; after a host reboot, the container may have started before that | On the Proxmox host, `nvidia-modprobe -u -c=0`, then restart the container |
| "Driver/library version mismatch" | The NVIDIA driver was updated, but the old kernel module is still loaded | Reboot the host |
| "GPU inference disabled" | Older Ollama versions turned the GPU off on CPUs without AVX, such as a VM with a generic CPU type | Give the VM the host's CPU type (Proxmox: Hardware → Processors → Type: `host`), or update Ollama |
| `CUDA_VISIBLE_DEVICES` names no GPU that `nvidia-smi` sees | CUDA hides every GPU from Ollama | Correct it on the Environment tab, or remove it |
| An AMD GPU in Ollama's log | With both AMD and NVIDIA GPUs, Ollama can pick the AMD one or fail on it | Set `ROCR_VISIBLE_DEVICES=-1` and `HIP_VISIBLE_DEVICES=-1` on the Environment tab |
| Ollama found no GPU at startup, with no other clue | Ollama started before the driver was ready, or the driver or Ollama was updated | Restart Ollama |
| No error in the log, and too little free VRAM | Other programs or models hold the VRAM | Free VRAM, then load the model again |
| No error in the log, and enough free VRAM | A client may have sent `num_gpu: 0` in its request options. The dashboard can't see request options | Check the client's settings |

**Reload nvidia_uvm and restart Ollama** stops Ollama, runs `modprobe -r nvidia_uvm` and `modprobe nvidia_uvm` (and `nvidia-modprobe -u -c=0` if the device node is still missing), then starts Ollama again. It's offered only when the Linux agent runs as root, outside a container, with the NVIDIA driver loaded. It fails while another program uses CUDA. In an LXC container the module belongs to the Proxmox host's kernel, so the check shows the command to run there instead.

## The GPU lost alert

The **Ollama lost the GPU** [alert rule](alerts.md#rules) fires when the check has said **GPU lost** for a minute, and resolves once it's back to **uses the GPU** or **CPU on purpose**. The alert's detail carries the summary and the likeliest cause. While the check is **not known yet**, the alert has no data, so it neither fires nor resolves.

## Older agents

Agents before 0.8.0 don't serve the GPU check's log reading or the `nvidia_uvm` state. The dashboard then reads the last 2000 lines from the agent's log tail instead, which can miss the discovery at startup on a busy host, and it can only offer **Restart Ollama**. The check says so. Update the agent for the full check.

The [hosts API](api.md#hosts) returns the result as `gpu_check` on each host.
