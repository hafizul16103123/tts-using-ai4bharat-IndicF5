import io
import threading

import numpy as np
import soundfile as sf
import torch
from transformers import AutoModel

from app.config import HF_TOKEN, MODEL_REPO_ID, SAMPLE_RATE

_lock = threading.Lock()
_model = None
_device = None


def get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_model():
    """Loads the IndicF5 model once and caches it in-process."""
    global _model, _device
    with _lock:
        if _model is None:
            _device = get_device()
            _model = AutoModel.from_pretrained(
                MODEL_REPO_ID,
                trust_remote_code=True,
                token=HF_TOKEN,
            ).to(_device)
    return _model


def is_loaded() -> bool:
    return _model is not None


def synthesize(text: str, ref_audio_path: str, ref_text: str) -> bytes:
    """Runs IndicF5 inference and returns a playable WAV file as bytes."""
    model = load_model()

    audio = model(text, ref_audio_path=ref_audio_path, ref_text=ref_text)
    audio = np.asarray(audio)

    if audio.dtype == np.int16:
        audio = audio.astype(np.float32) / 32768.0
    else:
        audio = audio.astype(np.float32)

    buffer = io.BytesIO()
    sf.write(buffer, audio, samplerate=SAMPLE_RATE, format="WAV")
    buffer.seek(0)
    return buffer.read()
