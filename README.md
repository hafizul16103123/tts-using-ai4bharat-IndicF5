# IndicF5 TTS Service

A backend service that turns Bengali text into speech using the AI model
[IndicF5](https://huggingface.co/ai4bharat/IndicF5). Built to handle **many users at the same
time**, not just one request at a time.

## What's Inside

| Part | Role |
|---|---|
| [`app/`](app/) | Python service. Wraps the IndicF5 model. Takes text, returns audio. |
| [`gateway/`](gateway/) | NestJS service in front of `app/`. Adds API-key login, a job queue, rate limits, and clean error handling. |

The AI model is slow (15-30 seconds per request) and can only do a few things at once. The
gateway makes sure many users can use it safely at the same time, without the model falling over.

## How to Run (Docker, recommended)

You need: **Docker Desktop**, and a Hugging Face token with access to
[ai4bharat/IndicF5](https://huggingface.co/ai4bharat/IndicF5) (the model is gated — request
access on that page first with the account that will own the token).

```powershell
# 1. Add your token
copy .env.example .env
# open .env and set: HF_TOKEN=hf_xxx

# 2. Build and start everything (starts 4 copies of the model + 4 workers, to show load handling)
docker compose -f docker-compose.scale.yml up -d --build

# 3. Wake up the model (first time downloads ~1-2GB of weights, a few minutes — this is normal)
for ($i=1; $i -le 8; $i++) { curl.exe -X POST http://127.0.0.1:8000/warmup }

# 4. Test it
curl.exe -X POST http://127.0.0.1:3000/tts -H "Content-Type: application/json" -H "x-api-key: key1" -d '{"text":"বাংলাদেশ একটি সুন্দর দেশ।"}'
```

(Using `curl.exe` on purpose — plain `curl` in PowerShell is aliased to `Invoke-WebRequest`, which
doesn't accept `-X`/`-H`/`-d` the same way.)

Or open **http://localhost:3000/** in a browser for a simple test page — enter API key `key1`,
type text, press submit. A ready-made [Postman collection](postman_collection.json) is also
included.

**To stop:** `docker compose -f docker-compose.scale.yml down`

Prefer running without Docker for faster local development? See
["Local Development"](#local-development-without-docker) below.

## Backend Architecture

```
clients → gateway-api → redis (job queue) → gateway-worker(s) → nginx (load balancer) → python-tts (model, N copies)
```

- **gateway-api** — takes the request, checks the API key, puts the job in the queue, returns a
  job ID right away (doesn't wait for the model).
- **redis + BullMQ** — the job queue. Tracks every job's state: queued, active, completed, failed.
- **gateway-worker** — picks jobs off the queue, calls the model, saves the result.
- **nginx** — spreads requests evenly across every running copy of the model.
- **python-tts** — the actual AI model, wrapped in a small API. Can run as several copies at
  once (horizontal scaling).

Client flow: `POST /tts` → get a `jobId` immediately → poll `GET /tts/:jobId` for status →
`GET /tts/:jobId/audio` once it's done.

## Why This Architecture

The model is CPU-heavy and slow. Calling it directly from every incoming request would make the
service choke the moment more than one user shows up. So instead:

1. **A job queue (BullMQ + Redis), not direct calls.** One slow job never blocks another user's
   request. Trade-off: one more piece of infra to run, but we get persistence, visibility into
   every job's state, and a natural place to add limits.
2. **The API and the worker are separate processes.** The API (`gateway-api`) is light and fast.
   The worker (`gateway-worker`) does the heavy lifting. This lets us scale them independently —
   few API servers, many workers, since the workers are the real bottleneck.
3. **Worker concurrency matches what the model can actually run.** The gateway never sends the
   model more jobs than it can truly run in parallel. Sending more wouldn't help — it would just
   create a second, invisible queue inside the model service, with less visibility and a real
   risk of timeouts.
4. **Limits everywhere.** Max queue size (backpressure), a per-API-key rate limit, a timeout on
   every model call, and no silent retries. This keeps the service predictable under heavy load
   instead of failing quietly.
5. **Horizontal scaling instead of one big machine.** Rather than one Python process trying to
   do everything, we run several small copies (`python-tts` × N) behind a load balancer
   (`nginx`). This is closer to how real production systems actually scale — add more machines,
   not more threads on one machine.

Full design notes and trade-offs for the gateway: [`gateway/README.md`](gateway/README.md).

## Multi-User Access

- Every request needs an `x-api-key` header. Keys map to users via `API_KEYS` in `gateway/.env`.
- Every job remembers who submitted it. Looking up another user's job returns `404` — a user
  can't even tell whether someone else's job exists.

## Concurrency & Load Handling

| Feature | How |
|---|---|
| Job queue | BullMQ + Redis, submit → poll pattern |
| Concurrency limit | Worker only sends as many jobs as the model can actually run at once |
| Backpressure | Queue full → `429` instead of growing forever |
| Rate limiting | Per API key, per minute |
| Timeouts | A hung model call fails cleanly instead of hanging forever |
| Horizontal scaling | Run more copies of the model + worker, load-balanced by nginx |

## Robustness

| Problem | Response |
|---|---|
| Empty or too-long text | `400` |
| Missing/invalid API key | `401` |
| Unknown job, or someone else's job | `404` |
| Job not ready yet / already failed (audio endpoint) | `409` |
| Queue full | `429` |
| Model service down, erroring, or too slow | Job marked `failed` with a reason — no raw stack trace leaked |

## Tested Under Real Load

This was tested with real concurrent requests, not just read through in theory:

| Setup | 8 jobs took | 
|---|---|
| 1 copy of the model | 254s |
| 4 copies (horizontal scaling) | 103s — **~2.5× faster** |

Killing one model copy mid-batch failed only the one job in flight to it (fast, in 6 seconds) —
every other job kept working, nothing got stuck.

Testing under real load also caught 3 real bugs (CPU oversubscription across copies, a shared-
storage gap between worker containers, and uneven load-balancing in nginx) — all found and fixed
during this build. Full story: [`gateway/README.md`](gateway/README.md#lessons-from-testing).

## Local Development (without Docker)

Faster to iterate on while coding — runs the Python service and gateway directly on this machine.

```powershell
# Python service
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m pip install torch torchaudio torchcodec --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python.exe -m pip install "transformers<4.50" git+https://github.com/ai4bharat/IndicF5.git
.\run_server.ps1

# Gateway (in another terminal, from gateway/)
docker compose up -d          # just Redis
copy .env.example .env
npm install
npm run start:dev             # API
npm run start:worker:dev      # worker (separate terminal)
```

See [`gateway/README.md`](gateway/README.md) for full setup details, the complete API reference,
and design notes.
