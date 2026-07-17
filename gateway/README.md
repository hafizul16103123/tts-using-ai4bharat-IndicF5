# TTS Gateway (NestJS)

The API layer in front of the Python IndicF5 service (`../app`). Adds what a real multi-user
service needs: API-key login, a job queue, limits, and clean error handling.

See the root [README.md](../README.md) for the big picture — how to run everything, the
architecture diagram, and why this design was chosen. This file goes deeper on the gateway
itself: setup, API reference, and design trade-offs.

## Why a Job Queue?

The Python model is slow (15-30 seconds per request) and can only run a few jobs at once
(`MAX_CONCURRENT_SYNTHESIS`, see `../app/model.py`). Forwarding every request to it directly
would mean users wait on long-open connections with no visibility, and the model gets
overwhelmed the moment demand goes up.

So instead: `POST /tts` puts the job in a **queue** (BullMQ + Redis) and returns immediately. A
separate **worker** picks jobs off the queue and calls the model. This turns "many people waiting
on one slow thing" into a clear, trackable state machine: `queued → active → completed/failed`.

## Design Decisions & Trade-offs

- **BullMQ + Redis, not an in-memory queue.** Jobs survive a gateway restart. Cost: one more
  piece of infra to run (small `docker-compose.yml` included, for local dev).
- **Worker concurrency matches the model's real capacity** (`WORKER_CONCURRENCY` = the model's
  `MAX_CONCURRENT_SYNTHESIS`). Sending the model more jobs than it can run in parallel doesn't
  help — it just creates a second, invisible queue inside the model service and risks timeouts.
- **Submit + poll, not streaming.** Simple to test with curl, Postman, or a browser:
  `POST /tts` → `jobId` → poll `GET /tts/:jobId` → `GET /tts/:jobId/audio`.
- **Backpressure**: once too many jobs are queued (`MAX_QUEUE_SIZE`), new ones get `429` instead
  of piling up forever.
- **Rate limiting**: each API key is capped per minute (`RATE_LIMIT_MAX`), so one user can't
  starve everyone else.
- **Per-user isolation**: every job remembers who submitted it. Someone else's job ID returns
  `404` — not even a "forbidden," so it doesn't confirm the job exists.
- **No silent retries**: a failed job (model down, timeout, error) is marked `failed` with a
  reason. We don't retry automatically — that would silently double the cost of an already-slow
  job. The caller decides whether to resubmit.
- **Result stored on disk** (`storage/<jobId>.wav`), not inside Redis — keeps Redis small and
  keeps job metadata separate from the actual audio, like a real system splits job state from
  object storage. In the horizontally-scaled setup (multiple worker containers), this needs
  shared storage — see "Lessons from Testing" below.
- **API and worker are separate processes** (`src/main.ts` vs `src/worker.main.ts`, same image,
  different command). This lets them scale independently: a few cheap, stateless API servers, and
  many workers — since the workers are the actual bottleneck-facing tier.

## Setup (local, without Docker)

Needs Node 20+ and Docker (for Redis only).

```powershell
docker compose up -d              # Redis, on host port 6380
copy .env.example .env
npm install
npm run start:dev                 # API
npm run start:worker:dev          # worker (run in a separate terminal)
```

Make sure the Python service is also running (`..\run_server.ps1`, from the repo root). Then
open `http://localhost:3000/` for the test page, or call the API directly.

## API

All `/tts*` routes need an `x-api-key` header. Keys are configured via `API_KEYS` in `.env`
(`key1:alice,key2:bob` by default).

### `POST /tts`
```json
{ "text": "বাংলাদেশ একটি সুন্দর দেশ।" }
```
→ `202 { "jobId": "..." }`. `400` if text is empty or too long, `401` if the key is
missing/wrong, `429` if the queue is full.

### `GET /tts/:jobId`
→ `200`, with status, timing, and which worker handled it:
```json
{
  "jobId": "...",
  "status": "queued | active | completed | failed",
  "createdAt": "15/07/2026, 21:15:32 (Asia/Dhaka)",
  "startedAt": "15/07/2026, 21:15:33 (Asia/Dhaka)",
  "completedAt": "15/07/2026, 21:16:04 (Asia/Dhaka)",
  "workerId": "a1b2c3d4e5f6",
  "durationSec": 31.02
}
```
Times are shown in Bangladesh local time. `workerId` is the hostname of whichever
`gateway-worker` replica processed the job (in Docker, a container's hostname is its container
ID — useful for seeing which copy did the work when horizontally scaled). `startedAt`/`workerId`
appear once a worker picks the job up; `durationSec` once it finishes. `404` if the job doesn't
exist or belongs to a different API key.

### `GET /tts/:jobId/audio`
→ `200` with the WAV file, once the job is `completed`. `409` if not finished yet or the job
failed, `404` for an unknown/foreign job.

## Test Page

`public/index.html`, served at `/`. Enter an API key (saved in `localStorage`) and text, submit
— it polls status and plays the audio once ready.

## Horizontal Scaling

This gateway is built to run as many API + worker copies as needed, all sharing one Redis queue
— see the root [README.md](../README.md#backend-architecture) and `../docker-compose.scale.yml`
for the full setup and how to run it.

## Lessons from Testing

Testing this with real concurrent traffic — not just reading the config — found 3 real bugs:

1. **CPU oversubscription.** Each container assumed it owned the whole machine's CPU cores, so
   running 4 copies used 4× too many threads. Fixed by telling each copy its actual fair share
   (`TORCH_THREADS`).
2. **Shared storage gap.** A worker saved the audio file to its own container's disk — invisible
   to the API container and every other worker. Fixed with a shared Docker volume.
3. **Uneven load balancing.** nginx's DNS-based routing looked correct on paper but didn't
   actually spread requests evenly — one model copy got zero traffic while another got
   double-booked. Fixed by switching to nginx's proper dynamic-upstream feature
   (`upstream {} ... server ... resolve;`).

All three only showed up under real concurrent load, not from reading the code. After the fixes:
4 model copies finished an 8-job batch in 103s vs 254s for 1 copy (~2.5× faster), and killing one
copy mid-batch only failed the single job in flight to it — everything else kept working.
