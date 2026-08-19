# Standalone Qwen3.5-9B runtime

This directory runs llama.cpp independently of Private AI Desktop. It exposes
the model only on `127.0.0.1:8080`; containers listen on `0.0.0.0` only inside
their isolated network namespace.

## Configure and start one profile

Copy the operator defaults before first use:

```powershell
Copy-Item .env.example .env
```

Run the command from this directory. Choose exactly one profile; each profile
uses the same loopback port and model files:

```powershell
docker compose --env-file .env --profile cpu up -d
docker compose --env-file .env --profile hybrid up -d
docker compose --env-file .env --profile gpu up -d
```

Stop the current profile before switching:

```powershell
docker compose --env-file .env down
```

The direct service URLs are:

- `http://127.0.0.1:8080/health`
- `http://127.0.0.1:8080/v1/models` (lists alias `Qwen3.5-9B`)
- `http://127.0.0.1:8080/v1/chat/completions`

`cpu` uses the standard server image with no GPU layers. `hybrid` uses the
CUDA image and offloads `LLAMA_GPU_LAYERS_HYBRID` layers. `gpu` uses the CUDA
image, full layer offload, Flash Attention, and quantized K/V cache. The CUDA
profiles require Docker GPU support on the host.

## Capacity defaults

The default `LLAMA_PARALLEL=1` and `LLAMA_CTX_SIZE=16384` provides one slot
with a 16,384-token total context capacity. `LLAMA_CTX_SIZE` is shared across
all slots: to operate two 16,384-token slots, set `LLAMA_PARALLEL=2` and
`LLAMA_CTX_SIZE=32768`. This increases K/V-cache memory substantially.

`LLAMA_N_PREDICT=8192` remains a server-side generation cap.

Stopping or exiting Electron never starts, stops, or otherwise manages this
runtime. Operators manage the Compose project explicitly with the commands
above.
