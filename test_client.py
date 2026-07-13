"""Quick smoke test for the IndicF5 TTS API."""
import sys

import requests

API_URL = "http://127.0.0.1:8000"
BENGALI_TEXT = "আমার সোনার বাংলা, আমি তোমায় ভালোবাসি।"


def main():
    print("Checking /health ...")
    r = requests.get(f"{API_URL}/health")
    r.raise_for_status()
    print(r.json())

    print("Requesting synthesis ...")
    r = requests.post(
        f"{API_URL}/tts",
        data={"text": BENGALI_TEXT},
        timeout=300,
    )
    if r.status_code != 200:
        print("Error:", r.status_code, r.text)
        sys.exit(1)

    with open("output.wav", "wb") as f:
        f.write(r.content)
    print(f"Saved {len(r.content)} bytes to output.wav")


if __name__ == "__main__":
    main()
