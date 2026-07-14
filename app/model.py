import asyncio
import io
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import soundfile as sf
import torch
from transformers import AutoModel

from app.config import HF_TOKEN, MAX_CONCURRENT_SYNTHESIS, MODEL_REPO_ID, SAMPLE_RATE, TORCH_THREADS

_lock = threading.Lock()
_model = None
_device = None

# Runs synthesis off the event loop so a slow request doesn't block /health, /voices,
# or other in-flight requests. Sized so concurrent inferences share the CPU instead of
# oversubscribing it: each one uses its own share of torch's intra-op threads.
_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_SYNTHESIS, thread_name_prefix="tts-worker")


def get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_model():
    """Loads the IndicF5 model once and caches it in-process."""
    global _model, _device
    with _lock:
        if _model is None:
            _device = get_device()
            if _device.type == "cpu":
                if TORCH_THREADS:
                    torch.set_num_threads(max(1, int(TORCH_THREADS)))
                else:
                    cores = os.cpu_count() or 1
                    torch.set_num_threads(max(1, cores // MAX_CONCURRENT_SYNTHESIS))
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


async def synthesize_async(text: str, ref_audio_path: str, ref_text: str) -> bytes:
    """Runs synthesize() in a worker thread so the event loop stays responsive and
    up to MAX_CONCURRENT_SYNTHESIS requests can genuinely run at once."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, synthesize, text, ref_audio_path, ref_text)
