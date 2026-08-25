@echo off
python -m pip install -U yt-dlp
echo Now install FFmpeg and add ffmpeg.exe and ffprobe.exe to PATH.
echo Verify with: yt-dlp --version ^& ffmpeg -version ^& ffprobe -version
pause
