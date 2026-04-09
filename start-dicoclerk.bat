@echo off
setlocal enabledelayedexpansion

REM ================================================================
REM start-dicoclerk.bat — Build and run dicoclerk Docker container
REM
REM WARNING: If democlaw restarts, dicoclerk MUST be restarted too.
REM Startup order: democlaw first, dicoclerk second.
REM ================================================================

set CONTAINER_NAME=dicoclerk
set IMAGE_NAME=dicoclerk:latest
set NETWORK=democlaw-net
set PORT=3000
set SCRIPT_DIR=%~dp0
set ENV_FILE=%SCRIPT_DIR%.env
set DATA_DIR=%SCRIPT_DIR%data
set FORCE_BUILD=0

REM ─── Parse arguments ─────────────────────────────────────────
:parse_args
if "%~1"=="" goto done_args
if /i "%~1"=="--network" set "NETWORK=%~2" & shift & shift & goto parse_args
if /i "%~1"=="--port" set "PORT=%~2" & shift & shift & goto parse_args
if /i "%~1"=="--build" set "FORCE_BUILD=1" & shift & goto parse_args
if /i "%~1"=="--env-file" set "ENV_FILE=%~2" & shift & shift & goto parse_args
if /i "%~1"=="--help" goto show_help
if /i "%~1"=="-h" goto show_help
echo [ERROR] Unknown option: %~1
exit /b 1
:done_args

REM ─── Validate env file ──────────────────────────────────────
if not exist "%ENV_FILE%" (
    echo [ERROR] .env file not found at: %ENV_FILE%
    echo         Run setup.sh first or create .env manually.
    exit /b 1
)

REM ─── Check network exists ───────────────────────────────────
docker network inspect %NETWORK% >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] Docker network '%NETWORK%' not found.
    echo         Is democlaw running? Start it first.
    echo         Or specify: start-dicoclerk.bat --network YOUR_NETWORK
    exit /b 1
)
echo [INFO] Using Docker network: %NETWORK%

REM ─── Build image if needed ──────────────────────────────────
if %FORCE_BUILD% equ 1 goto do_build
docker image inspect %IMAGE_NAME% >nul 2>&1
if !errorlevel! neq 0 goto do_build
echo [INFO] Image %IMAGE_NAME% exists. Use --build to rebuild.
goto skip_build

:do_build
echo [INFO] Building image %IMAGE_NAME%...
docker build -t %IMAGE_NAME% "%SCRIPT_DIR%."
if !errorlevel! neq 0 (
    echo [ERROR] Docker build failed.
    exit /b 1
)
echo [OK] Image built.

:skip_build

REM ─── Stop existing container ────────────────────────────────
docker container inspect %CONTAINER_NAME% >nul 2>&1
if !errorlevel! equ 0 (
    echo [INFO] Removing existing container...
    docker stop %CONTAINER_NAME% >nul 2>&1
    docker rm %CONTAINER_NAME% >nul 2>&1
)

REM ─── Create data dirs ──────────────────────────────────────
if not exist "%DATA_DIR%\transcripts" mkdir "%DATA_DIR%\transcripts"
if not exist "%DATA_DIR%\minutes" mkdir "%DATA_DIR%\minutes"
if not exist "%DATA_DIR%\recordings" mkdir "%DATA_DIR%\recordings"

REM ─── Run container (single line to avoid ^ issues in PS) ────
echo [INFO] Starting container...
docker run -d --name %CONTAINER_NAME% --network %NETWORK% --network-alias dicoclerk -p %PORT%:3000 --env-file "%ENV_FILE%" -v "%DATA_DIR%:/app/data" --restart unless-stopped %IMAGE_NAME%
if !errorlevel! neq 0 (
    echo [ERROR] Failed to start container.
    exit /b 1
)
echo [OK] Container started.

REM ─── Wait for health ────────────────────────────────────────
echo [INFO] Waiting for health check...
set WAITED=0
set MAX_WAIT=60

:health_loop
if %WAITED% geq %MAX_WAIT% goto health_timeout

REM Use a temp file to avoid for/f issues with Go template braces
docker inspect --format "{{.State.Health.Status}}" %CONTAINER_NAME% > "%TEMP%\dicoclerk_health.txt" 2>nul
set /p HEALTH=<"%TEMP%\dicoclerk_health.txt"

if "!HEALTH!"=="healthy" (
    echo.
    echo [OK] Container is healthy!
    goto show_summary
)
if "!HEALTH!"=="unhealthy" (
    echo.
    echo [ERROR] Container is unhealthy. Run: docker logs %CONTAINER_NAME%
    exit /b 1
)

set /a WAITED+=2
set /p "=." <nul
timeout /t 2 /nobreak >nul 2>&1
goto health_loop

:health_timeout
echo.
echo [WARN] Health check timed out after %MAX_WAIT%s. May still be starting.

:show_summary
echo.
echo ==========================================
echo    dicoclerk container running
echo ==========================================
echo.
echo   Container:  %CONTAINER_NAME%
echo   Network:    %NETWORK%
echo   MCP SSE:    http://dicoclerk:%PORT%/sse
echo   Health:     http://dicoclerk:%PORT%/health
echo   Local:      http://localhost:%PORT%/sse
echo.
echo   Logs:  docker logs -f %CONTAINER_NAME%
echo   Stop:  docker stop %CONTAINER_NAME%
echo.
echo   WARNING: If democlaw restarts, run this script again.
echo.
exit /b 0

:show_help
echo Usage: start-dicoclerk.bat [OPTIONS]
echo.
echo   --network NAME   Docker network (default: democlaw-net)
echo   --port PORT      MCP SSE port (default: 3000)
echo   --build          Force rebuild image
echo   --env-file PATH  Path to .env file
echo   --help           Show help
exit /b 0
