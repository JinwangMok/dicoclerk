@echo off
setlocal enabledelayedexpansion

REM start-dicoclerk.bat - Build and run dicoclerk Docker container
REM If democlaw restarts, dicoclerk MUST be restarted too.

set CONTAINER_NAME=dicoclerk
set IMAGE_NAME=dicoclerk:latest
set NETWORK=democlaw-net
set PORT=3000
set SCRIPT_DIR=%~dp0
set ENV_FILE=%SCRIPT_DIR%.env
set DATA_DIR=%SCRIPT_DIR%data
set FORCE_BUILD=0

if "%~1"=="--build" set FORCE_BUILD=1
if "%~1"=="--network" set "NETWORK=%~2"
if "%~1"=="--help" goto show_help
if "%~1"=="-h" goto show_help

if not exist "%ENV_FILE%" (
    echo [ERROR] .env not found. Run setup.sh first.
    exit /b 1
)

docker network inspect %NETWORK% >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] Network %NETWORK% not found. Start democlaw first.
    exit /b 1
)
echo [INFO] Network: %NETWORK%

if %FORCE_BUILD% equ 1 goto do_build
docker image inspect %IMAGE_NAME% >nul 2>&1
if !errorlevel! neq 0 goto do_build
echo [INFO] Image exists. Use --build to rebuild.
goto skip_build

:do_build
echo [INFO] Building %IMAGE_NAME%...
docker build -t %IMAGE_NAME% "%SCRIPT_DIR%."
if !errorlevel! neq 0 (
    echo [ERROR] Build failed.
    exit /b 1
)
echo [OK] Built.

:skip_build

docker container inspect %CONTAINER_NAME% >nul 2>&1
if !errorlevel! equ 0 (
    echo [INFO] Removing old container...
    docker stop %CONTAINER_NAME% >nul 2>&1
    docker rm %CONTAINER_NAME% >nul 2>&1
)

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

echo [INFO] Starting container...
docker run -d --name %CONTAINER_NAME% --network %NETWORK% --network-alias dicoclerk -p %PORT%:3000 --env-file "%ENV_FILE%" -v "%DATA_DIR%:/app/data" --restart unless-stopped %IMAGE_NAME%
if !errorlevel! neq 0 (
    echo [ERROR] Failed to start.
    exit /b 1
)
echo [OK] Started.

echo [INFO] Waiting for health...
set WAITED=0

:health_loop
if %WAITED% geq 60 goto health_timeout
docker inspect --format "{{.State.Health.Status}}" %CONTAINER_NAME% > "%TEMP%\dch.txt" 2>nul
set /p HEALTH=<"%TEMP%\dch.txt"
if "!HEALTH!"=="healthy" (
    echo.
    echo [OK] Healthy!
    goto summary
)
if "!HEALTH!"=="unhealthy" (
    echo.
    echo [ERROR] Unhealthy. Run: docker logs %CONTAINER_NAME%
    exit /b 1
)
set /a WAITED+=2
set /p "=." <nul
timeout /t 2 /nobreak >nul 2>&1
goto health_loop

:health_timeout
echo.
echo [WARN] Timed out. Check: docker logs %CONTAINER_NAME%

:summary
echo.
echo Container: %CONTAINER_NAME%
echo Network:   %NETWORK%
echo MCP SSE:   http://dicoclerk:%PORT%/sse
echo Local:     http://localhost:%PORT%/sse
echo Logs:      docker logs -f %CONTAINER_NAME%
echo Stop:      docker stop %CONTAINER_NAME%
echo.
exit /b 0

:show_help
echo Usage: start-dicoclerk.bat [--build] [--network NAME] [--help]
exit /b 0
