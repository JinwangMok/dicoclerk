#!/usr/bin/env bash
#
# start-dicoclerk.sh — Build and run dicoclerk as a Docker container
#
# ⚠️  ORDERING DEPENDENCY: democlaw's start.sh destroys and recreates
#     the Docker network. If democlaw restarts, dicoclerk MUST be
#     restarted afterwards.
#     Startup order: democlaw first → dicoclerk second
#

set -euo pipefail

# ─── Colors & helpers ──────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${CYAN}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✔${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✖${NC}  $*" >&2; }

# ─── Defaults ──────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_NAME="dicoclerk"
IMAGE_NAME="dicoclerk:latest"
DEFAULT_NETWORK="democlaw-net"
NETWORK=""
PORT="3000"
ENV_FILE="${SCRIPT_DIR}/.env"
FORCE_BUILD=false
DATA_DIR="${SCRIPT_DIR}/data"

# ─── Auto-detect container runtime ─────────────────────────────
if command -v docker &>/dev/null; then
    RUNTIME="docker"
elif command -v podman &>/dev/null; then
    RUNTIME="podman"
else
    error "Neither docker nor podman found. Install one and retry."
    exit 1
fi

# ─── Parse CLI options ─────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --network)
            NETWORK="$2"; shift 2 ;;
        --port)
            PORT="$2"; shift 2 ;;
        --build)
            FORCE_BUILD=true; shift ;;
        --env-file)
            ENV_FILE="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: start-dicoclerk.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --network <name>   Docker network (default: auto-detect democlaw-net)"
            echo "  --port <port>      MCP SSE port (default: 3000)"
            echo "  --build            Force rebuild image before starting"
            echo "  --env-file <path>  Path to .env file (default: .env)"
            echo "  --help             Show this help"
            exit 0 ;;
        *)
            error "Unknown option: $1"
            exit 1 ;;
    esac
done

# ─── Validate env file ─────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
    error ".env file not found at: $ENV_FILE"
    error "Run 'bash setup.sh' first to create it."
    exit 1
fi

# ─── Auto-detect network ──────────────────────────────────────
if [[ -z "$NETWORK" ]]; then
    if $RUNTIME network inspect "$DEFAULT_NETWORK" &>/dev/null; then
        NETWORK="$DEFAULT_NETWORK"
        info "Auto-detected Docker network: ${NETWORK}"
    else
        error "Docker network '${DEFAULT_NETWORK}' not found."
        error "Is democlaw running? Start it first with 'make start' in the democlaw directory."
        error "Or specify a custom network with: --network <name>"
        exit 1
    fi
fi

# Verify the specified network exists
if ! $RUNTIME network inspect "$NETWORK" &>/dev/null; then
    error "Docker network '${NETWORK}' does not exist."
    error "Available networks:"
    $RUNTIME network ls --format '  - {{.Name}}' 2>/dev/null || true
    exit 1
fi

# ─── Build image ───────────────────────────────────────────────
if $FORCE_BUILD || ! $RUNTIME image inspect "$IMAGE_NAME" &>/dev/null; then
    info "Building Docker image: ${IMAGE_NAME}..."
    $RUNTIME build -t "$IMAGE_NAME" "$SCRIPT_DIR"
    success "Image built: ${IMAGE_NAME}"
else
    info "Image ${IMAGE_NAME} already exists. Use --build to force rebuild."
fi

# ─── Stop existing container ───────────────────────────────────
if $RUNTIME container inspect "$CONTAINER_NAME" &>/dev/null; then
    warn "Stopping existing container: ${CONTAINER_NAME}..."
    $RUNTIME stop "$CONTAINER_NAME" 2>/dev/null || true
    $RUNTIME rm "$CONTAINER_NAME" 2>/dev/null || true
    success "Removed existing container."
fi

# ─── Create data directory ─────────────────────────────────────
mkdir -p "$DATA_DIR"/{transcripts,minutes,recordings}

# ─── Run container ─────────────────────────────────────────────
info "Starting container on network '${NETWORK}'..."

$RUNTIME run -d \
    --name "$CONTAINER_NAME" \
    --network "$NETWORK" \
    --network-alias dicoclerk \
    -p "${PORT}:3000" \
    --env-file "$ENV_FILE" \
    -v "${DATA_DIR}:/app/data" \
    --restart unless-stopped \
    "$IMAGE_NAME"

success "Container '${CONTAINER_NAME}' started."

# ─── Wait for health check ────────────────────────────────────
info "Waiting for health check..."
MAX_WAIT=60
WAITED=0

while [[ $WAITED -lt $MAX_WAIT ]]; do
    HEALTH=$($RUNTIME inspect --format='{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "starting")

    if [[ "$HEALTH" == "healthy" ]]; then
        success "Container is healthy!"
        break
    elif [[ "$HEALTH" == "unhealthy" ]]; then
        error "Container is unhealthy. Check logs:"
        error "  $RUNTIME logs $CONTAINER_NAME"
        exit 1
    fi

    sleep 2
    WAITED=$((WAITED + 2))
    printf "."
done
echo ""

if [[ $WAITED -ge $MAX_WAIT ]]; then
    warn "Health check timed out after ${MAX_WAIT}s. Container may still be starting."
    warn "Check status: $RUNTIME inspect --format='{{.State.Health.Status}}' $CONTAINER_NAME"
fi

# ─── Summary ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       dicoclerk container running        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Container:  ${CYAN}${CONTAINER_NAME}${NC}"
echo -e "  Network:    ${CYAN}${NETWORK}${NC}"
echo -e "  MCP SSE:    ${CYAN}http://dicoclerk:${PORT}/sse${NC}"
echo -e "  Health:     ${CYAN}http://dicoclerk:${PORT}/health${NC}"
echo -e "  Local:      ${CYAN}http://localhost:${PORT}/sse${NC}"
echo ""
echo -e "  Logs:       ${CYAN}$RUNTIME logs -f $CONTAINER_NAME${NC}"
echo -e "  Stop:       ${CYAN}$RUNTIME stop $CONTAINER_NAME${NC}"
echo ""
warn "If democlaw restarts, you must restart dicoclerk too:"
echo -e "    ${CYAN}bash start-dicoclerk.sh${NC}"
echo ""
