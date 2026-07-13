import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
PROMPTS_DIR = BASE_DIR / "assets" / "prompts"
VOICES_REGISTRY_PATH = PROMPTS_DIR / "voices.json"

HF_TOKEN = os.getenv("HF_TOKEN")
MODEL_REPO_ID = os.getenv("INDICF5_MODEL_REPO", "ai4bharat/IndicF5")
DEFAULT_VOICE = os.getenv("INDICF5_DEFAULT_VOICE", "bn")
SAMPLE_RATE = 24000
