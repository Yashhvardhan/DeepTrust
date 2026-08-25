$ErrorActionPreference = "Stop"
Write-Host "DeepTrust video-forensics setup"
python -m pip install -U yt-dlp
Write-Host "yt-dlp installed. Now install FFmpeg and ensure ffmpeg.exe and ffprobe.exe are on PATH."
Write-Host "Windows options: winget install Gyan.FFmpeg or install from https://ffmpeg.org/download.html"
Write-Host "Verify with: yt-dlp --version ; ffmpeg -version ; ffprobe -version"
