# IndicF5 TTS API

A functional FastAPI wrapper around [ai4bharat/IndicF5](https://huggingface.co/ai4bharat/IndicF5), a zero-shot voice-cloning TTS model for 11 Indian languages. This API accepts Bengali (or any supported Indic-language) text and returns a playable WAV file.

## How IndicF5 works

IndicF5 is not a plain "text in, speaker's default voice out" model — it needs a **reference prompt** (a short audio clip + its transcript) to clone prosody/voice from, then synthesizes your target text in that voice. The target text's language does not need to match the reference audio's language (cross-lingual cloning works well — this is exactly how AI4Bharat's own demo generates Bengali speech from a Kannada reference clip).

This API bundles 5 ready-to-use reference voices (downloaded from the official repo) under `assets/prompts/`, registered in `assets/prompts/voices.json`, so you can call the API with just `text` and get audio back immediately. You can also upload your own reference audio + transcript to clone a different voice.

## Setup

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

## Run

```powershell
.\run_server.ps1
```

This prepends the shared-FFmpeg `bin` directory to `PATH` and starts `uvicorn app.main:app` on `0.0.0.0:8000`. (Running `uvicorn` directly without that `PATH` entry will fail at synthesis time with a `torchcodec`/`libtorchcodec` load error.)

The model loads lazily on the first `/tts` call (or eagerly via `POST /warmup`). First load downloads ~1-2GB of gated model weights and can take a few minutes; inference runs on CPU on this machine (no CUDA GPU detected), so expect a few seconds per request depending on text length.

## Endpoints

### `POST /tts`
`multipart/form-data`:
| field | required | description |
|---|---|---|
| `text` | yes | Text to synthesize (e.g. Bengali) |
| `voice` | no (default `kan_f_happy`) | Preset voice name from `/voices` |
| `ref_audio` | no | Upload a custom reference clip to clone instead of a preset voice |
| `ref_text` | required if `ref_audio` set | Transcript of `ref_audio` |

Returns `audio/wav` bytes directly — playable in a browser `<audio>` tag or any media player.

```bash
curl -X POST http://127.0.0.1:8000/tts \
  -F "text=আমার সোনার বাংলা, আমি তোমায় ভালোবাসি।" \
  -F "voice=kan_f_happy" \
  -o output.wav
```

### `GET /voices`
Lists available preset voices and their reference transcripts.

### `POST /warmup`
Forces the model to load immediately instead of on first request.

### `GET /health`
Liveness + whether the model is currently loaded in memory.

## Test

```powershell
.venv\Scripts\python.exe test_client.py
```

Hits `/health`, synthesizes a sample Bengali sentence, and saves it to `output.wav`.
# tts-using-ai4bharat-IndicF5
