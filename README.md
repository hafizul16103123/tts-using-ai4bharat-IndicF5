# IndicF5 TTS Service

A production-minded backend around [ai4bharat/IndicF5](https://huggingface.co/ai4bharat/IndicF5), a zero-shot voice-cloning TTS model, exposing Bengali text-to-speech over HTTP for multiple concurrent users.

The system has two parts:

| Part | What it does |
|---|---|
| [`app/`](app/) | A Python/FastAPI service that wraps IndicF5 itself: text in, WAV bytes out. |
| [`gateway/`](gateway/) | A NestJS API in front of it, adding API-key auth with per-user isolation, a Redis/BullMQ job queue with a bounded worker, backpressure, timeouts, rate limiting, and sane error handling for concurrent multi-user load. |

The Python service alone is a thin model wrapper — it has no auth, and can only run a bounded
number of syntheses at once (`MAX_CONCURRENT_SYNTHESIS`, currently 2, via a small thread pool so
its event loop stays responsive; each call still takes 15-30s on CPU). The gateway is what turns
that into something that behaves reasonably under many simultaneous users: an explicit job queue
instead of requests piling up past what the backend can run, isolation between users' jobs, and
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
- **Concurrency**: a worker pulls up to `WORKER_CONCURRENCY` jobs at a time from the queue and
  calls the Python service — matching the Python service's own `MAX_CONCURRENT_SYNTHESIS`, so the
  gateway dispatches exactly as much real parallel work as the backend can actually run, no more.
- **Backpressure**: once too many jobs are queued/active (`MAX_QUEUE_SIZE`), new submissions get
  `429` instead of the queue growing unboundedly.
- **Rate limiting**: each API key is capped to `RATE_LIMIT_MAX` requests per `RATE_LIMIT_TTL_MS`
  on `POST /tts` (polling routes are exempt).
- **Timeouts, no silent retries**: the call to the Python backend has a timeout
  (`PYTHON_TTS_TIMEOUT_MS`); on timeout or error the job is marked `failed` with a reason instead
  of retrying a 30s CPU-bound job automatically.

Full rationale and trade-offs for each of these: [`gateway/README.md`](gateway/README.md).

## Horizontal scaling

The setup above is one Python process and one gateway process — real, but bounded by one
machine's CPU core share. `docker-compose.scale.yml` containerizes the whole system so the
Python inference tier and the gateway's worker tier can each be scaled out independently, instead
of just raising one process's internal concurrency:

```
                     ┌─────────────┐
   clients ────────► │ gateway-api │  (stateless HTTP — cheap, not the bottleneck)
                     └──────┬──────┘
                            │ enqueue/poll
                     ┌──────▼──────┐
                     │    redis    │  (shared BullMQ queue)
                     └──────┬──────┘
                            │ consume
                  ┌─────────┴─────────┐
                  │  gateway-worker   │  × M replicas (each WORKER_CONCURRENCY jobs)
                  └─────────┬─────────┘
                            │ HTTP (round-robin via nginx)
                     ┌──────▼──────┐
                     │    nginx    │
                     └──────┬──────┘
                  ┌─────────┴─────────┐
                  │    python-tts     │  × N replicas (each MAX_CONCURRENT_SYNTHESIS jobs)
                  └───────────────────┘
```

Total real concurrent capacity ≈ `N × MAX_CONCURRENT_SYNTHESIS`, matched by
`M × WORKER_CONCURRENCY` on the gateway side (keep these two products equal — dispatching more
jobs to Python than it can run in parallel just queues them *inside* Python's thread pool instead
of the gateway's, with less visibility and a real risk of timeouts).

Run it (defaults to 4 replicas each):

```powershell
docker compose -f docker-compose.scale.yml up -d --build
```

`redis` and `nginx` run as one instance each (redis is a shared broker; nginx is a cheap L7 load
balancer using Docker's embedded DNS to round-robin across however many `python-tts` replicas
are currently up — see `deploy/nginx.conf`). `gateway-api` also runs as one instance since it's
stateless and lightweight; scale it too the same way if HTTP-handling itself ever became the
bottleneck, which it isn't here.

### What actually happened when this was tested

Building this surfaced a real bug, not just a config exercise: `os.cpu_count()` inside a
container reports the *host's* full core count regardless of how many other replicas are
running, so each container's thread math (`app/model.py`) independently assumed it owned all 16
cores. At 4 replicas that oversubscribed the CPU by 4×, and every job in the first test batch
either failed or came within a hair of the timeout. Fixed with an explicit `TORCH_THREADS`
override (each replica told its *actual* fair share — see `docker-compose.scale.yml`) instead of
relying on auto-detection, which silently breaks the moment more than one process shares a host.

With that fixed and `MAX_CONCURRENT_SYNTHESIS=1` per replica (simplest to reason about: N
replicas = N total concurrent jobs), an 8-job batch was timed both ways on this machine:

| Config | Total time for 8 jobs | Throughput |
|---|---|---|
| 1 replica (16 threads) | 254s | ~1.9 jobs/min |
| 4 replicas (4 threads each) | 103s | ~4.7 jobs/min |

**~2.5× throughput from 4× the replicas — not a full 4×**, because giving each replica only
4 threads instead of 16 also makes each individual job slower (less intra-op parallelism per
inference). That's the honest shape of horizontal scaling *on one box*: real gains, sub-linear,
because replicas are still splitting one finite core budget rather than adding hardware. This is
exactly the ceiling described above — it's what running real additional hardware (more
machines, or GPUs) removes.

A replica was also killed mid-batch to check failure behavior: the one job actively in flight to
it failed fast and cleanly (`502` in 6s — nginx detected the dead upstream immediately, no hang),
while every other job, including ones still queued for that same replica, completed normally on
the remaining 3. No stuck jobs, no cascading failure.

A second bug turned up once multiple `gateway-worker`/`gateway-api` replicas were actually
exercised: `GET /tts/:jobId/audio` returned "Stored audio result is no longer available" even
though the job showed `completed`. Cause: whichever `gateway-worker` replica processed the job
wrote the WAV to *its own* container's local disk — invisible to `gateway-api` (a different
container) when the client polled for it, and invisible to every other worker replica too. Fixed
with a shared `gateway-storage` Docker volume mounted into `gateway-api` and every
`gateway-worker` replica. That fix is honestly scoped to this demo, though: a plain named volume
only works because every replica is on the same Docker host — a real multi-node deployment
(Swarm/Kubernetes across separate machines) would need actual shared storage (S3-compatible
object storage, EFS/NFS) instead, since local volumes don't span hosts.

A third bug, found by submitting 4 jobs at once and watching 2 of them time out: nginx wasn't
actually load-balancing evenly. The original `deploy/nginx.conf` used
`set $upstream http://python-tts:8000; proxy_pass $upstream;` — the standard-looking trick for
forcing nginx to re-resolve a Docker service name via its embedded DNS instead of caching the
first IP forever. In practice, verified with `docker stats` during a live 4-job test, this stuck
to a single resolved backend per connection rather than spreading across all 4 replica IPs: one
replica sat at 0% CPU the entire run while another got double-booked, and the second job queued
behind it on that single-concurrency replica blew past the timeout. Fixed by switching to nginx's
purpose-built mechanism for this — an `upstream {}` block with `zone` + `server ... resolve;`
(OSS nginx 1.27.3+; the `nginx:alpine` image here runs 1.31.2) — which keeps a live, shared pool
of every resolved IP and properly round-robins across it. Re-ran the same 4-concurrent-job test
after the fix: all 4 replicas showed ~387-393% CPU simultaneously and all 4 jobs completed
together in ~45s. The lesson: the "put the hostname in a variable" DNS re-resolution trick is a
common recommendation online, but it doesn't actually load-balance across multiple IPs in stock
nginx — worth verifying with real concurrent traffic and `docker stats`, not just trusting that a
config "looks right."

**The honest capacity math**: this machine has 16 CPU cores and no GPU. Every replica above is a
container sharing those same 16 cores — running more replicas on *one box* doesn't add hardware,
it just repartitions the same core budget, with diminishing (and eventually negative) returns past
the core count. What this demo actually proves is the *mechanism*: N replicas give ~N× throughput
up to that hardware ceiling, the queue drains proportionally faster, and a replica can be killed
mid-batch without the whole system hanging (in-flight jobs routed to it simply time out and get
marked `failed`, per the existing no-retry design). Reaching a literal 100 concurrent jobs means
running that many replicas' worth of `MAX_CONCURRENT_SYNTHESIS` across **real additional
hardware** — more physical/cloud machines, or a handful of GPU-backed instances (GPUs batch
inference requests instead of just interleaving CPU threads, so a couple of GPU replicas would
get you there far more cheaply than dozens of CPU boxes). The architecture here — stateless API,
shared Redis queue, independently-scalable workers, load-balanced inference tier — is exactly
what you'd point at more hardware to get there; nothing about it is single-machine-specific
except the replica counts.

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

The model loads lazily on the first `/tts` call (or eagerly via `POST /warmup`). First load downloads ~1-2GB of gated model weights and can take a few minutes; inference runs on CPU on this machine (no CUDA GPU detected), so expect 15-30s per request depending on text length. `/tts` runs synthesis in a small thread pool (`MAX_CONCURRENT_SYNTHESIS`, default 2) rather than blocking the event loop, so `/health` and other requests stay responsive and a bounded number of syntheses can genuinely run in parallel — but that bound is still real, which is exactly why the gateway (above) queues requests rather than forwarding them all straight through.

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
