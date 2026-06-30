@echo off
echo Restarting project...
docker compose down
docker compose up -d --build
echo.
echo Project restarted!
echo Open Web UI in browser: http://localhost:3000
echo.
pause
