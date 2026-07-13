import json
from functools import lru_cache

from app.config import PROMPTS_DIR, VOICES_REGISTRY_PATH


@lru_cache
def load_voice_registry() -> dict:
    with open(VOICES_REGISTRY_PATH, "r", encoding="utf-8") as f:
        registry = json.load(f)
    for voice in registry.values():
        voice["path"] = str(PROMPTS_DIR / voice["file"])
    return registry


def resolve_voice(name: str) -> dict:
    registry = load_voice_registry()
    if name not in registry:
        raise KeyError(f"Unknown voice '{name}'. Available: {', '.join(registry)}")
    return registry[name]
