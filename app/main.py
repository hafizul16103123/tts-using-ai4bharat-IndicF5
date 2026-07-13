import logging

from fastapi import FastAPI, Form, HTTPException
from fastapi.responses import Response

from app import model as tts_model
from app.config import DEFAULT_VOICE
from app.voices import load_voice_registry, resolve_voice

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("indicf5-api")

app = FastAPI(
    title="IndicF5 TTS API",
    description="Functional API wrapping ai4bharat/IndicF5 — synthesizes Bengali (and other Indic-language) text into playable speech.",
    version="1.0.0",
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_loaded": tts_model.is_loaded(),
    }


@app.post("/warmup")
def warmup():
    """Eagerly loads the model into memory instead of waiting for the first /tts call."""
    tts_model.load_model()
    return {"status": "ready", "device": str(tts_model.get_device())}


@app.get("/voices")
def list_voices():
    registry = load_voice_registry()
    return {
        name: {"label": v["label"], "ref_text": v["ref_text"]}
        for name, v in registry.items()
    }


@app.post(
    "/tts",
    responses={200: {"content": {"audio/wav": {}}}},
    response_class=Response,
)
async def text_to_speech(
    text: str = Form(..., description="Text to synthesize (Bengali or any supported Indic language)."),
):
    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="`text` must not be empty.")

    try:
        voice_entry = resolve_voice(DEFAULT_VOICE)
    except KeyError as e:
        raise HTTPException(status_code=400, detail=str(e))
    ref_audio_path = voice_entry["path"]
    resolved_ref_text = voice_entry["ref_text"]

    try:
        wav_bytes = tts_model.synthesize(text, ref_audio_path, resolved_ref_text)
    except Exception as e:
        logger.exception("TTS synthesis failed")
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {e}")

    return Response(content=wav_bytes, media_type="audio/wav")
