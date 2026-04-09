@echo off
setlocal enabledelayedexpansion

REM ================================================================
REM start-dicoclerk.bat — Build and run dicoclerk as a Docker container
REM
REM WARNING: If democlaw restarts, dicoclerk MUST be restarted too.
REM Startup order: democlaw first -> dicoclerk second
REM ================================================================

set CONTAINER_NAME=dicoclerk
set IMAGE_NAME=dicoclerk:latest
set DEFAULT_NETWORK=democlaw-net
set NETWORK=
set PORT=3000
set ENV_FILE=%~dp0.env
set FORCE_BUILD=0
set DATA_DIR=%~dp0data

REM ─── Parse arguments ─────────────────────────────────────────
:parse_args
if "%~1"=="" goto :done_args
if "%~1"=="--network" (set NETWORK=%~2& shift& shift& goto :parse_args)
if "%~1"=="--port" (set PORT=%~2& shift& shift& goto :parse_args)
if "%~1"=="--build" (set FORCE_BUILD=1& shift& goto :parse_args)
if "%~1"=="--env-file" (set ENV_FILE=%~2& shift& shift& goto :parse_args)
if "%~1"=="--help" goto :show_help
if "%~1"=="-h" goto :show_help
echo [ERROR] Unknown option: %~1
exit /b 1
:done_args

REM ─── Validate env file ──────────────────────────────────────
if not exist "%ENV_FILE%" (
    echo [ERROR] .env file not found at: %ENV_FILE%
    echo         Run 'bash setup.sh' or create .env manually first.
    exit /b 1
)

REM ─── Auto-detect network ────────────────────────────────────
if "%NETWORK%"=="" (
    docker network inspect %DEFAULT_NETWORK% >nul 2>&1
    if !errorlevel! equ 0 (
        set NETWORK=%DEFAULT_NETWORK%
        echo [INFO] Auto-detected Docker network: !NETWORK!
    ) else (
        echo [ERROR] Docker network '%DEFAULT_NETWORK%' not found.
        echo         Is democlaw running? Start it first.
        echo         Or specify: --network ^<name^>
        exit /b 1
    )
)

REM ─── Verify network exists ──────────────────────────────────
docker network inspect %NETWORK% >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker network '%NETWORK%' does not exist.
    docker network ls
    exit /b 1
)

REM ─── Build image ────────────────────────────────────────────
if %FORCE_BUILD% equ 1 goto :do_build
docker image inspect %IMAGE_NAME% >nul 2>&1
if %errorlevel% neq 0 goto :do_build
echo [INFO] Image %IMAGE_NAME% already exists. Use --build to force rebuild.
goto :skip_build

:do_build
echo [INFO] Building Docker image: %IMAGE_NAME%...
docker build -t %IMAGE_NAME% "%~dp0"
if %errorlevel% neq 0 (
    echo [ERROR] Docker build failed.
    exit /b 1
)
echo [OK] Image built: %IMAGE_NAME%

:skip_build

REM ─── Stop existing container ────────────────────────────────
docker container inspect %CONTAINER_NAME% >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Stopping existing container: %CONTAINER_NAME%...
    docker stop %CONTAINER_NAME% >nul 2>&1
    docker rm %CONTAINER_NAME% >nul 2>&1
    echo [OK] Removed existing container.
)

REM ─── Create data directories ────────────────────────────────
if not exist "%DATA_DIR%\transcripts" mkdir "%DATA_DIR%\transcripts"
if not exist "%DATA_DIR%\minutes" mkdir "%DATA_DIR%\minutes"
if not exist "%DATA_DIR%\recordings" mkdir "%DATA_DIR%\recordings"

REM ─── Run container ──────────────────────────────────────────
echo [INFO] Starting container on network '%NETWORK%'...

docker run -d ^
    --name %CONTAINER_NAME% ^
    --network %NETWORK% ^
    --network-alias dicoclerk ^
    -p %PORT%:3000 ^
    --env-file "%ENV_FILE%" ^
    -v "%DATA_DIR%:/app/data" ^
    --restart unless-stopped ^
    %IMAGE_NAME%

if %errorlevel% neq 0 (
    echo [ERROR] Failed to start container.
    exit /b 1
)

echo [OK] Container '%CONTAINER_NAME%' started.

REM ─── Wait for health check ─────────────────────────────────
echo [INFO] Waiting for health check...
set /a WAITED=0
set /a MAX_WAIT=60

:health_loop
if %WAITED% geq %MAX_WAIT% goto :health_timeout

for /f "tokens=*" %%h in ('docker inspect --format="{{.State.Health.Status}}" %CONTAINER_NAME% 2^>nul') do set HEALTH=%%h

if "%HEALTH%"=="healthy" (
    echo.
    echo [OK] Container is healthy!
    goto :show_summary
)
if "%HEALTH%"=="unhealthy" (
    echo.
    echo [ERROR] Container is unhealthy. Check logs:
    echo         docker logs %CONTAINER_NAME%
    exit /b 1
)

set /a WAITED+=2
<nul set /p =.
timeout /t 2 /nobreak >nul
goto :health_loop

:health_timeout
echo.
echo [WARN] Health check timed out after %MAX_WAIT%s. Container may still be starting.
echo        Check: docker inspect --format="{{.State.Health.Status}}" %CONTAINER_NAME%

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
echo   Logs:       docker logs -f %CONTAINER_NAME%
echo   Stop:       docker stop %CONTAINER_NAME%
echo.
echo   WARNING: If democlaw restarts, restart dicoclerk too:
echo            start-dicoclerk.bat
echo.
exit /b 0

:show_help
echo Usage: start-dicoclerk.bat [OPTIONS]
echo.
echo Options:
echo   --network ^<name^>   Docker network (default: auto-detect democlaw-net)
echo   --port ^<port^>      MCP SSE port (default: 3000)
echo   --build            Force rebuild image before starting
echo   --env-file ^<path^>  Path to .env file (default: .env)
echo   --help             Show this help
exit /b 0
