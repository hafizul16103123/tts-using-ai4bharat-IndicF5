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

# How many synthesis requests can run at once, off the event loop, in worker threads.
# Each one uses torch's intra-op threads for its own compute, so this is capped against
# the CPU core count in model.py to avoid oversubscribing.
MAX_CONCURRENT_SYNTHESIS = int(os.getenv("MAX_CONCURRENT_SYNTHESIS", "2"))

# Torch intra-op threads per synthesis. Defaults to os.cpu_count() // MAX_CONCURRENT_SYNTHESIS
# (model.py), which assumes this process owns the whole machine — true for a single native
# instance, false when horizontally scaled: Docker's default CPU visibility reports the
# *host's* full core count inside every container, so N replicas would each independently
# claim a full share and oversubscribe the shared cores by N×. Set this explicitly to the
# replica's fair share (host cores / (replica_count * MAX_CONCURRENT_SYNTHESIS)) when running
# more than one replica per host — see docker-compose.scale.yml.
TORCH_THREADS = os.getenv("TORCH_THREADS")
