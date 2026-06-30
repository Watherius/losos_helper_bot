@echo off
echo Starting project...
docker compose up -d --build
echo.
echo Project started successfully!
echo Open Web UI in browser: http://localhost:3000
echo.
pause
