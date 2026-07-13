# IndicF5 TTS Service

A production-minded backend around [ai4bharat/IndicF5](https://huggingface.co/ai4bharat/IndicF5), a zero-shot voice-cloning TTS model, exposing Bengali text-to-speech over HTTP for multiple concurrent users.

The system has two parts:

| Part | What it does |
|---|---|
| [`app/`](app/) | A Python/FastAPI service that wraps IndicF5 itself: text in, WAV bytes out. |
| [`gateway/`](gateway/) | A NestJS API in front of it, adding API-key auth with per-user isolation, a Redis/BullMQ job queue with a bounded worker, backpressure, timeouts, rate limiting, and sane error handling for concurrent multi-user load. |

The Python service alone is a thin, single-request model wrapper — it has no auth and can only
truly process one synthesis at a time (each call takes 15-30s on CPU). The gateway is what turns
that into something that behaves reasonably under many simultaneous users: request queuing
instead of requests piling up on a blocked event loop, isolation between users' jobs, and
explicit limits instead of unbounded growth. **The gateway is the primary deliverable** for the
concurrency/multi-user/robustness requirements; see [`gateway/README.md`](gateway/README.md) for
the full design write-up and trade-offs.

## Quick start

Three things need to be running: the Python model service, Redis (for the gateway's job queue),
and the gateway itself.

```powershell
# 1. Python IndicF5 service (see "Python service setup" below for first-time setup)
.\run_server.ps1

# 2. Redis, dedicated to the gateway (from gateway/)
cd gateway
docker compose up -d

# 3. Gateway (from gateway/)
copy .env.example .env
npm install
npm run start:dev
```

Open `http://localhost:3000/` for a bundled HTML test page (enter an API key from
`gateway/.env`'s `API_KEYS`, e.g. `key1`, type Bengali text, submit, and it polls status and plays
the resulting audio). A [Postman collection](postman_collection.json) is also included, covering
both the raw Python service and the gateway.

## Multi-user access & concurrency & load (gateway)

- **Auth**: every `/tts*` request requires an `x-api-key` header, mapped to a user identity via
  `API_KEYS` in `gateway/.env`.
- **Per-user isolation**: jobs are tagged with the submitting user's id; looking up another
  user's job (status or audio) returns `404`, never leaking that it exists.
- **Queueing**: `POST /tts` enqueues a BullMQ job and returns a `jobId` immediately (`202`);
  clients poll `GET /tts/:jobId` for status and `GET /tts/:jobId/audio` once `completed`.
- **Concurrency**: a worker pulls one job at a time from the queue and calls the Python service —
  matching the fact that the Python backend can only do one synthesis at a time anyway, so this
  serializes real work instead of piling up blocked requests against it.
- **Backpressure**: once too many jobs are queued/active (`MAX_QUEUE_SIZE`), new submissions get
  `429` instead of the queue growing unboundedly.
- **Rate limiting**: each API key is capped to `RATE_LIMIT_MAX` requests per `RATE_LIMIT_TTL_MS`
  on `POST /tts` (polling routes are exempt).
- **Timeouts, no silent retries**: the call to the Python backend has a timeout
  (`PYTHON_TTS_TIMEOUT_MS`); on timeout or error the job is marked `failed` with a reason instead
  of retrying a 30s CPU-bound job automatically.

Full rationale and trade-offs for each of these: [`gateway/README.md`](gateway/README.md).

## Robustness (unhappy paths)

| Condition | Response |
|---|---|
| Empty/whitespace-only text | `400` |
| Text over `MAX_TEXT_LENGTH` | `400` |
| Missing/invalid API key | `401` |
| Unknown or foreign `jobId` | `404` |
| Job not finished yet / job failed (audio endpoint) | `409` |
| Queue full | `429` |
| Python backend down, erroring, or timing out | job `failed` with a message; never a raw stack trace |

## Python service setup

Requires Python 3.11 (already provisioned in `.venv` — IndicF5 pins `numpy<=1.26.4`, which has no wheels for Python 3.13+).

```powershell
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m pip install torch torchaudio torchcodec --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python.exe -m pip install "transformers<4.50" git+https://github.com/ai4bharat/IndicF5.git
```

(torch/torchaudio/torchcodec are installed separately from the CPU wheel index so this stays a small CPU-only footprint — no CUDA GPU was detected on this machine.)

Set your Hugging Face token in `.env` (already created) — required because `ai4bharat/IndicF5` is a gated model:

```
HF_TOKEN=hf_xxx
```

You must have requested/been granted access to the model at https://huggingface.co/ai4bharat/IndicF5 with the account that issued this token.

### FFmpeg (shared build)

Recent `torchaudio` loads audio via `torchcodec`, which dynamically links FFmpeg's shared libraries (`avcodec-*.dll`, `avformat-*.dll`, etc.) — the static `ffmpeg.exe`-only build is not enough. A shared FFmpeg 8.x build is already extracted to `%LOCALAPPDATA%\Programs\ffmpeg-shared\bin`. `run_server.ps1` puts it on `PATH` automatically. If you set this up elsewhere, grab the "full_build-shared" archive from https://www.gyan.dev/ffmpeg/builds/ and point `run_server.ps1` at its `bin` folder.

### Run

```powershell
.\run_server.ps1
```

This prepends the shared-FFmpeg `bin` directory to `PATH` and starts `uvicorn app.main:app` on `0.0.0.0:8000`. (Running `uvicorn` directly without that `PATH` entry will fail at synthesis time with a `torchcodec`/`libtorchcodec` load error.)

The model loads lazily on the first `/tts` call (or eagerly via `POST /warmup`). First load downloads ~1-2GB of gated model weights and can take a few minutes; inference runs on CPU on this machine (no CUDA GPU detected), so expect 15-30s per request depending on text length. This is exactly why the gateway (above) queues requests rather than forwarding them straight through.

### Endpoints

#### `POST /tts`
`multipart/form-data`:
| field | required | description |
|---|---|---|
| `text` | yes | Text to synthesize (e.g. Bengali) |

Always uses the default bundled voice (`bn`). Returns `audio/wav` bytes directly — playable in a browser `<audio>` tag or any media player.

```bash
curl -X POST http://127.0.0.1:8000/tts \
  -F "text=আমার সোনার বাংলা, আমি তোমায় ভালোবাসি।" \
  -o output.wav
```

#### `GET /voices`
Lists available preset voices and their reference transcripts.

#### `POST /warmup`
Forces the model to load immediately instead of on first request.

#### `GET /health`
Liveness + whether the model is currently loaded in memory.

### Test

```powershell
.venv\Scripts\python.exe test_client.py
```

Hits `/health`, synthesizes a sample Bengali sentence, and saves it to `output.wav`.
