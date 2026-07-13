# TTS Gateway (NestJS)

A production-minded API gateway in front of the existing Python IndicF5 service (`../app`).
The Python service stays untouched — it's treated as an external, single-threaded, CPU-bound
inference backend. This gateway adds what a real multi-user deployment needs around it:
API-key auth with per-user isolation, a job queue with a bounded worker, backpressure, timeouts,
rate limiting, and sane error responses.

## Why a queue in front of a "wrapper"?

The Python service's `/tts` handler is `async def` but calls model inference *synchronously*
inside the event loop — a single Uvicorn worker can only do one synthesis at a time regardless of
how many requests arrive concurrently; extra concurrent requests just pile up. Each synthesis
also takes 15-30s on this CPU-only machine. Given that, naively forwarding every incoming request
straight to Python would mean concurrent callers blocking each other with long-hanging HTTP
connections, no visibility into position-in-queue, and no way to protect the backend from being
overwhelmed. Wrapping it in a **BullMQ job queue + a single-concurrency worker** turns that into an
explicit, observable state machine (`queued → active → completed/failed`) instead of an
opaque blocking call, and gives us a place to add backpressure, timeouts, and per-user isolation.

## Design decisions & trade-offs

- **BullMQ + Redis, not an in-memory queue.** Chosen for persistence (jobs survive a gateway
  restart) and because it's the standard, inspectable Node job/worker pattern. Trade-off: an
  extra piece of infra to run (a small `docker-compose.yml` is included, on host port `6380` to
  avoid clashing with any other local Redis).
- **Worker concurrency defaults to 1** (`WORKER_CONCURRENCY`). Raising it would not add real
  parallelism against the current Python backend — it would only make it contend with itself —
  so serializing at the gateway is both correct and the simplest option. If the Python service
  were changed to run inference in a thread/process pool, this number could be raised in lockstep.
- **Submit + poll**, not streaming. `POST /tts` returns a `jobId` immediately (202); the client
  polls `GET /tts/:jobId` for status and `GET /tts/:jobId/audio` once `completed`. Simple to
  exercise from curl, Postman, or the bundled HTML page.
- **Backpressure via a queue-depth cap** (`MAX_QUEUE_SIZE`, default 20): once that many jobs are
  waiting/active/delayed, new submissions get `429` instead of growing the queue unboundedly.
- **Per-API-key rate limiting** (`RATE_LIMIT_MAX` per `RATE_LIMIT_TTL_MS`, default 10/min) on
  `POST /tts` only — polling `GET /tts/:jobId` and `GET /tts/:jobId/audio` are exempt so a client
  can poll frequently without tripping the limit.
- **Per-user isolation**: every job is tagged with the caller's `userId` (derived from their API
  key). Looking up another user's `jobId` returns `404` (not `403`), so it doesn't even confirm
  the job exists.
- **No automatic retries**: a failed job (Python backend down, timeout, error) is surfaced to the
  client as `status: "failed"` with a reason. Silently retrying a 30s CPU-bound job is expensive;
  the client can decide to resubmit.
- **Results stored on disk** (`storage/<jobId>.wav`), not as a base64 blob inside the Redis job
  record — keeps Redis lean and separates job metadata from the actual audio blob, the way a real
  system would split job state from object storage.

## Setup

Requires Node 20+ and Docker (for Redis).

```powershell
# 1. Start Redis for this gateway (isolated from any other Redis on the machine)
docker compose up -d

# 2. Configure
copy .env.example .env
# edit .env if needed — defaults work out of the box with ../run_server.ps1

# 3. Install & run
npm install
npm run start:dev
```

Make sure the existing Python service is also running (from the repo root):

```powershell
.\run_server.ps1
```

Then open `http://localhost:3000/` for the bundled test page, or use the API directly.

## API

All `/tts*` routes require an `x-api-key` header. Valid keys are configured via `API_KEYS` in
`.env` (`key1:alice,key2:bob` by default).

### `POST /tts`
```json
{ "text": "বাংলাদেশ একটি সুন্দর দেশ।" }
```
→ `202 { "jobId": "..." }`. `400` on empty/oversized text, `401` on missing/invalid API key,
`429` once the queue is full.

### `GET /tts/:jobId`
→ `200 { "jobId", "status": "queued"|"active"|"completed"|"failed", "error"?, "createdAt", "completedAt"? }`.
`404` if the job doesn't exist or belongs to a different API key.

### `GET /tts/:jobId/audio`
→ `200` with `audio/wav` bytes once the job is `completed`. `409` if not finished yet or the job
failed, `404` for an unknown/foreign job.

## Test page

`public/index.html`, served at `/`. Enter an API key (persisted in `localStorage`) and text,
submit, and it polls status and plays the resulting audio once ready.

## Verifying concurrency & backpressure

- Fire several `POST /tts` requests back-to-back and poll each `jobId` — you'll see them move
  through `queued → active → completed` one at a time (proving the worker really does serialize
  against the Python backend).
- Temporarily set `MAX_QUEUE_SIZE=1` in `.env`, restart, and fire two requests at once — the
  second gets `429`.
