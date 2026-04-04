#!/usr/bin/env bash
#
# dicoclerk — Interactive Setup Script
# Collects Discord token, Deepgram API key, server/channel IDs
# and writes them to .env
#

set -euo pipefail

# ─── Colors & helpers ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${CYAN}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✔${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✖${NC}  $*"; }

# ─── Banner ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║         ${CYAN}dicoclerk${NC}${BOLD} — Setup Wizard          ║${NC}"
echo -e "${BOLD}║  Discord Voice Meeting Clerk Bot         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# ─── Load existing values if .env exists ────────────────────────────
EXISTING_DISCORD_TOKEN=""
EXISTING_DISCORD_CLIENT_ID=""
EXISTING_DEEPGRAM_API_KEY=""
EXISTING_DISCORD_GUILD_ID=""
EXISTING_STT_LANGUAGE=""
EXISTING_MINUTES_CHANNEL_ID=""
EXISTING_DATA_DIR=""

if [[ -f "$ENV_FILE" ]]; then
    warn "Existing .env file found. Current values will be shown as defaults."
    echo ""
    # Source existing values safely
    while IFS='=' read -r key value; do
        # Skip comments and empty lines
        [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
        # Trim whitespace
        key=$(echo "$key" | xargs)
        value=$(echo "$value" | xargs)
        case "$key" in
            DISCORD_TOKEN)        EXISTING_DISCORD_TOKEN="$value" ;;
            DISCORD_CLIENT_ID)    EXISTING_DISCORD_CLIENT_ID="$value" ;;
            DEEPGRAM_API_KEY)     EXISTING_DEEPGRAM_API_KEY="$value" ;;
            DISCORD_GUILD_ID)     EXISTING_DISCORD_GUILD_ID="$value" ;;
            STT_LANGUAGE)         EXISTING_STT_LANGUAGE="$value" ;;
            MINUTES_CHANNEL_ID)   EXISTING_MINUTES_CHANNEL_ID="$value" ;;
            DATA_DIR)             EXISTING_DATA_DIR="$value" ;;
        esac
    done < "$ENV_FILE"
fi

# ─── Helper: prompt with default ────────────────────────────────────
prompt_value() {
    local prompt_text="$1"
    local default_val="$2"
    local is_secret="${3:-false}"
    local result=""

    if [[ -n "$default_val" ]]; then
        if [[ "$is_secret" == "true" && ${#default_val} -gt 8 ]]; then
            local masked="${default_val:0:4}...${default_val: -4}"
            echo -en "  ${prompt_text} [${masked}]: "
        else
            echo -en "  ${prompt_text} [${default_val}]: "
        fi
    else
        echo -en "  ${prompt_text}: "
    fi

    read -r result
    if [[ -z "$result" ]]; then
        result="$default_val"
    fi
    echo "$result"
}

# ─── Helper: prompt required (no empty allowed) ─────────────────────
prompt_required() {
    local prompt_text="$1"
    local default_val="$2"
    local is_secret="${3:-false}"
    local result=""

    while true; do
        result=$(prompt_value "$prompt_text" "$default_val" "$is_secret")
        if [[ -n "$result" ]]; then
            echo "$result"
            return
        fi
        error "This field is required. Please enter a value."
    done
}

# ═══════════════════════════════════════════════════════════════════
# Section 1: Discord Configuration
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}─── Discord Bot Configuration ─────────────────────${NC}"
echo ""
info "You need a Discord bot token from https://discord.com/developers/applications"
info "Make sure the bot has:"
info "  • MESSAGE CONTENT intent enabled"
info "  • GUILD VOICE STATES intent enabled"
info "  • GUILD MEMBERS intent enabled (for speaker identification)"
echo ""

DISCORD_TOKEN=$(prompt_required "Discord Bot Token" "$EXISTING_DISCORD_TOKEN" "true")

echo ""
info "The Client ID (Application ID) is on the General Information page."
DISCORD_CLIENT_ID=$(prompt_required "Discord Client ID (Application ID)" "$EXISTING_DISCORD_CLIENT_ID")

echo ""
info "Guild ID is used for faster slash command registration during development."
info "Right-click your server → Copy Server ID (enable Developer Mode in settings)."
DISCORD_GUILD_ID=$(prompt_value "Discord Guild ID (optional, recommended)" "$EXISTING_DISCORD_GUILD_ID")

echo ""
info "Channel where meeting minutes will be posted after each session."
info "Right-click a text channel → Copy Channel ID."
MINUTES_CHANNEL_ID=$(prompt_value "Minutes Text Channel ID (optional, configurable per-session)" "$EXISTING_MINUTES_CHANNEL_ID")

echo ""
success "Discord configuration collected."
echo ""

# ═══════════════════════════════════════════════════════════════════
# Section 2: Deepgram Configuration
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}─── Deepgram STT Configuration ────────────────────${NC}"
echo ""
info "Get your Deepgram API key from https://console.deepgram.com"
info "A free tier account provides \$200 in credits."
echo ""

DEEPGRAM_API_KEY=$(prompt_required "Deepgram API Key" "$EXISTING_DEEPGRAM_API_KEY" "true")

echo ""
echo -e "  Select STT language support:"
echo -e "    ${CYAN}1)${NC} Korean only (ko)"
echo -e "    ${CYAN}2)${NC} English only (en)"
echo -e "    ${CYAN}3)${NC} Multi-language — Korean & English (multi) ${YELLOW}[default]${NC}"
echo ""

DEFAULT_LANG_CHOICE="3"
if [[ "$EXISTING_STT_LANGUAGE" == "ko" ]]; then
    DEFAULT_LANG_CHOICE="1"
elif [[ "$EXISTING_STT_LANGUAGE" == "en" ]]; then
    DEFAULT_LANG_CHOICE="2"
fi

echo -en "  Language choice [${DEFAULT_LANG_CHOICE}]: "
read -r LANG_CHOICE
LANG_CHOICE="${LANG_CHOICE:-$DEFAULT_LANG_CHOICE}"

case "$LANG_CHOICE" in
    1) STT_LANGUAGE="ko" ;;
    2) STT_LANGUAGE="en" ;;
    *) STT_LANGUAGE="multi" ;;
esac

echo ""
success "Deepgram configuration collected (language: ${STT_LANGUAGE})."
echo ""

# ═══════════════════════════════════════════════════════════════════
# Section 3: Storage Configuration
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}─── Storage Configuration ─────────────────────────${NC}"
echo ""
info "Transcripts and meeting minutes are stored on local disk."
info "Default: ./data (relative to project root)"
echo ""

DATA_DIR=$(prompt_value "Data directory" "${EXISTING_DATA_DIR:-./data}")

echo ""
success "Storage configuration collected."
echo ""

# ═══════════════════════════════════════════════════════════════════
# Write .env file
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}─── Writing Configuration ─────────────────────────${NC}"
echo ""

cat > "$ENV_FILE" <<EOF
# ============================================
# dicoclerk — Configuration
# Generated by setup.sh on $(date '+%Y-%m-%d %H:%M:%S')
# ============================================

# Discord Bot Configuration
DISCORD_TOKEN=${DISCORD_TOKEN}
DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}

# Optional: Guild ID for development (faster command registration)
DISCORD_GUILD_ID=${DISCORD_GUILD_ID}

# Optional: Default text channel for posting meeting minutes
MINUTES_CHANNEL_ID=${MINUTES_CHANNEL_ID}

# Deepgram API Configuration
DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY}

# Language settings (ko, en, or multi for both)
STT_LANGUAGE=${STT_LANGUAGE}

# Data storage directory (transcripts, minutes, recordings)
DATA_DIR=${DATA_DIR}
EOF

success ".env file written to: ${ENV_FILE}"

# ─── Create data directory ──────────────────────────────────────────
# Resolve DATA_DIR relative to SCRIPT_DIR if relative path
if [[ "$DATA_DIR" == ./* || "$DATA_DIR" == ../* ]]; then
    FULL_DATA_DIR="$SCRIPT_DIR/$DATA_DIR"
else
    FULL_DATA_DIR="$DATA_DIR"
fi

mkdir -p "$FULL_DATA_DIR/transcripts" "$FULL_DATA_DIR/minutes" "$FULL_DATA_DIR/recordings" 2>/dev/null || true
success "Data directories created: ${FULL_DATA_DIR}/{transcripts,minutes,recordings}"
echo ""

# ─── Install dependencies if needed ─────────────────────────────────
echo -e "${BOLD}─── Dependencies ──────────────────────────────────${NC}"
echo ""

if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
    info "Installing Node.js dependencies..."
    (cd "$SCRIPT_DIR" && npm install)
    success "Dependencies installed."
else
    success "Node modules already installed."
fi
echo ""

# ─── Deploy slash commands ───────────────────────────────────────────
echo -e "${BOLD}─── Slash Command Registration ────────────────────${NC}"
echo ""
echo -en "  Register /start and /stop slash commands now? [Y/n]: "
read -r DEPLOY_CHOICE
DEPLOY_CHOICE="${DEPLOY_CHOICE:-Y}"

if [[ "$DEPLOY_CHOICE" =~ ^[Yy]$ ]]; then
    info "Deploying slash commands..."
    if (cd "$SCRIPT_DIR" && node src/deploy-commands.js 2>&1); then
        success "Slash commands registered."
    else
        warn "Command registration failed. You can retry later with: npm run deploy-commands"
    fi
else
    info "Skipped. Run 'npm run deploy-commands' when ready."
fi
echo ""

# ═══════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║          ${GREEN}Setup Complete!${NC}${BOLD}                  ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Quick Start:${NC}"
echo -e "    ${CYAN}npm start${NC}          — Run the bot"
echo -e "    ${CYAN}npm run dev${NC}        — Run with auto-reload"
echo -e "    ${CYAN}npm run mcp${NC}        — Run as MCP server"
echo ""
echo -e "  ${BOLD}Bot Invite URL:${NC}"
echo -e "    https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&permissions=36727824&scope=bot%20applications.commands"
echo ""
echo -e "  ${BOLD}Required Bot Permissions:${NC}"
echo -e "    • Connect to voice channels"
echo -e "    • Speak in voice channels"
echo -e "    • Send messages"
echo -e "    • Attach files"
echo -e "    • Use slash commands"
echo ""
info "Run ${CYAN}npm start${NC} to launch dicoclerk!"
echo ""
