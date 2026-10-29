# Limitations

- The Linux agent assumes Ollama runs under systemd, as with the official install script. If Ollama runs in Docker, set its environment in compose instead. Monitoring and model management still work.
- The Windows agent targets the standard Ollama desktop install. If you run `ollama serve` as a Windows service (NSSM or similar), the agent can't manage that service's environment.
- On Windows with consumer GPUs, `nvidia-smi` doesn't report per-process VRAM (a WDDM limitation), so the process table is empty there.
- Removing a parameter in the model editor may not drop it from the derived model if Ollama inherits it from the base layer. To clear one, set it explicitly to the value you want.
