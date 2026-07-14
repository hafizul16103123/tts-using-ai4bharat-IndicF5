# IndicF5 Python TTS service, containerized so it can be run as N horizontally-scaled
# replicas behind a load balancer (see ../docker-compose.scale.yml).
FROM python:3.11-slim

# ffmpeg on Debian ships shared libs (unlike the Windows static build), so torchcodec
# can dlopen them with no extra PATH setup — none of run_server.ps1's FFmpeg dance is needed here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir torch torchaudio torchcodec --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir "transformers<4.50" git+https://github.com/ai4bharat/IndicF5.git

COPY app ./app
COPY assets ./assets

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
