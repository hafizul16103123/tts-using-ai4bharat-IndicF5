$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ffmpegBin = "$env:LOCALAPPDATA\Programs\ffmpeg-shared\bin"
$env:PATH = "$ffmpegBin;$env:PATH"

& "$root\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 0.0.0.0 --port 8000
