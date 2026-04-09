#Requires -Version 5.1
<#
.SYNOPSIS
    Build and run dicoclerk as a Docker container.

.DESCRIPTION
    WARNING: If democlaw restarts, dicoclerk MUST be restarted too.
    Startup order: democlaw first -> dicoclerk second

.PARAMETER Network
    Docker network name (default: auto-detect democlaw-net)

.PARAMETER Port
    MCP SSE port (default: 3000)

.PARAMETER Build
    Force rebuild image before starting

.PARAMETER EnvFile
    Path to .env file (default: .env in script directory)
#>
param(
    [string]$Network = "",
    [int]$Port = 3000,
    [switch]$Build,
    [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ContainerName = "dicoclerk"
$ImageName = "dicoclerk:latest"
$DefaultNetwork = "democlaw-net"
$DataDir = Join-Path $ScriptDir "data"

if (-not $EnvFile) {
    $EnvFile = Join-Path $ScriptDir ".env"
}

# ─── Validate env file ──────────────────────────────────────
if (-not (Test-Path $EnvFile)) {
    Write-Host "[ERROR] .env file not found at: $EnvFile" -ForegroundColor Red
    Write-Host "        Run 'bash setup.sh' or create .env manually first."
    exit 1
}

# ─── Auto-detect network ────────────────────────────────────
if (-not $Network) {
    $null = docker network inspect $DefaultNetwork 2>&1
    if ($LASTEXITCODE -eq 0) {
        $Network = $DefaultNetwork
        Write-Host "[INFO] Auto-detected Docker network: $Network" -ForegroundColor Cyan
    } else {
        Write-Host "[ERROR] Docker network '$DefaultNetwork' not found." -ForegroundColor Red
        Write-Host "        Is democlaw running? Start it first."
        Write-Host "        Or specify: -Network <name>"
        exit 1
    }
}

# Verify network exists
$null = docker network inspect $Network 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Docker network '$Network' does not exist." -ForegroundColor Red
    docker network ls
    exit 1
}

# ─── Build image ────────────────────────────────────────────
$needBuild = $Build.IsPresent
if (-not $needBuild) {
    $null = docker image inspect $ImageName 2>&1
    if ($LASTEXITCODE -ne 0) { $needBuild = $true }
}

if ($needBuild) {
    Write-Host "[INFO] Building Docker image: $ImageName..." -ForegroundColor Cyan
    docker build -t $ImageName $ScriptDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Docker build failed." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Image built: $ImageName" -ForegroundColor Green
} else {
    Write-Host "[INFO] Image $ImageName already exists. Use -Build to force rebuild." -ForegroundColor Cyan
}

# ─── Stop existing container ────────────────────────────────
$null = docker container inspect $ContainerName 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "[INFO] Stopping existing container: $ContainerName..." -ForegroundColor Yellow
    docker stop $ContainerName 2>$null | Out-Null
    docker rm $ContainerName 2>$null | Out-Null
    Write-Host "[OK] Removed existing container." -ForegroundColor Green
}

# ─── Create data directories ────────────────────────────────
New-Item -ItemType Directory -Path "$DataDir\transcripts" -Force | Out-Null
New-Item -ItemType Directory -Path "$DataDir\minutes" -Force | Out-Null
New-Item -ItemType Directory -Path "$DataDir\recordings" -Force | Out-Null

# ─── Run container ──────────────────────────────────────────
Write-Host "[INFO] Starting container on network '$Network'..." -ForegroundColor Cyan

docker run -d `
    --name $ContainerName `
    --network $Network `
    --network-alias dicoclerk `
    -p "${Port}:3000" `
    --env-file $EnvFile `
    -v "${DataDir}:/app/data" `
    --restart unless-stopped `
    $ImageName

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Failed to start container." -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Container '$ContainerName' started." -ForegroundColor Green

# ─── Wait for health check ──────────────────────────────────
Write-Host "[INFO] Waiting for health check..." -ForegroundColor Cyan
$maxWait = 60
$waited = 0

while ($waited -lt $maxWait) {
    $health = (docker inspect --format='{{.State.Health.Status}}' $ContainerName 2>$null)

    if ($health -eq "healthy") {
        Write-Host ""
        Write-Host "[OK] Container is healthy!" -ForegroundColor Green
        break
    }
    if ($health -eq "unhealthy") {
        Write-Host ""
        Write-Host "[ERROR] Container is unhealthy. Check logs:" -ForegroundColor Red
        Write-Host "        docker logs $ContainerName"
        exit 1
    }

    Write-Host "." -NoNewline
    Start-Sleep -Seconds 2
    $waited += 2
}

if ($waited -ge $maxWait) {
    Write-Host ""
    Write-Host "[WARN] Health check timed out after ${maxWait}s." -ForegroundColor Yellow
}

# ─── Summary ────────────────────────────────────────────────
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "   dicoclerk container running" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Container:  $ContainerName" -ForegroundColor Cyan
Write-Host "  Network:    $Network" -ForegroundColor Cyan
Write-Host "  MCP SSE:    http://dicoclerk:${Port}/sse" -ForegroundColor Cyan
Write-Host "  Health:     http://dicoclerk:${Port}/health" -ForegroundColor Cyan
Write-Host "  Local:      http://localhost:${Port}/sse" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Logs:       docker logs -f $ContainerName" -ForegroundColor Cyan
Write-Host "  Stop:       docker stop $ContainerName" -ForegroundColor Cyan
Write-Host ""
Write-Host "  WARNING: If democlaw restarts, restart dicoclerk too:" -ForegroundColor Yellow
Write-Host "           .\start-dicoclerk.ps1" -ForegroundColor Cyan
Write-Host ""
