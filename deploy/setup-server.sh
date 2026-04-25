#!/bin/bash
# =============================================================
# Twatter VPS Setup Script
# Run this on a fresh Ubuntu 22.04 VPS as root
# Usage: bash setup-server.sh
# =============================================================

set -e

echo ""
echo "========================================"
echo "   TWATTER SERVER SETUP"
echo "   Algorithm-free social media"
echo "========================================"
echo ""

# --- 1. Install Docker ---
echo "[1/5] Installing Docker..."
if command -v docker &> /dev/null; then
    echo "  Docker already installed: $(docker --version)"
else
    curl -fsSL https://get.docker.com | sh
    echo "  Docker installed: $(docker --version)"
fi

# Make sure docker compose plugin is available
if ! docker compose version &> /dev/null; then
    echo "  Installing docker compose plugin..."
    apt-get update -qq && apt-get install -y -qq docker-compose-plugin
fi
echo "  Docker Compose: $(docker compose version)"

# --- 2. Create project directory ---
echo ""
echo "[2/5] Setting up project directory..."
PROJECT_DIR="/opt/twatter"
mkdir -p "$PROJECT_DIR"

# Check if we're running from the project dir or need to copy
if [ -f "./docker-compose.yml" ]; then
    echo "  Running from deploy directory, copying project..."
    cp -r ../* "$PROJECT_DIR/" 2>/dev/null || true
    cp -r ../.[!.]* "$PROJECT_DIR/" 2>/dev/null || true
elif [ -f "$PROJECT_DIR/deploy/docker-compose.yml" ]; then
    echo "  Project already in $PROJECT_DIR"
else
    echo "  ERROR: Can't find project files."
    echo "  Upload the project first with:"
    echo "    scp -r /path/to/twatter root@YOUR_SERVER_IP:/opt/twatter"
    exit 1
fi

cd "$PROJECT_DIR/deploy"

# --- 3. Create .env file ---
echo ""
echo "[3/5] Setting up environment..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "  Created .env from template"
    echo ""
    echo "  !! IMPORTANT: Edit .env before continuing !!"
    echo "  Run: nano $PROJECT_DIR/deploy/.env"
    echo ""
    echo "  You need to set:"
    echo "    - CLIENT_URL (your domain, or http://YOUR_SERVER_IP for now)"
    echo "    - ALBYHUB_PASSWORD (you'll set this in step 4)"
    echo ""
    read -p "  Press Enter after editing .env (or press Enter to continue with defaults)... "
else
    echo "  .env already exists"
fi

# --- 4. Create certs directory ---
mkdir -p certs

# --- 5. Start everything ---
echo ""
echo "[4/5] Starting all services..."
docker compose up -d --build

echo ""
echo "[5/5] Waiting for services to start..."
sleep 10

# Check health
echo ""
echo "========================================"
echo "   SERVICE STATUS"
echo "========================================"
docker compose ps
echo ""

# Test endpoints
echo "Testing services..."
for service in "relay:7777:/" "media:7778:/health" "payment:7779:/health"; do
    IFS=':' read -r name port path <<< "$service"
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port$path" | grep -q "200\|426"; then
        echo "  $name (:$port) ........... UP"
    else
        echo "  $name (:$port) ........... DOWN (check: docker compose logs $name)"
    fi
done

# Check Alby Hub
if curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080" | grep -q "200\|301\|302"; then
    echo "  albyhub (:8080) ......... UP"
else
    echo "  albyhub (:8080) ......... STARTING (may take a minute)"
fi

echo ""
echo "========================================"
echo "   NEXT STEPS"
echo "========================================"
echo ""
echo "1. SET UP ALBY HUB (required for payments):"
echo "   Open http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP'):8080"
echo "   - Choose a password"
echo "   - Connect to Lightning network"
echo "   - Go to Settings > Connections > + New connection"
echo "   - Copy the NWC URL"
echo "   - Paste it in $PROJECT_DIR/deploy/.env as NWC_URL=..."
echo "   - Also set ALBYHUB_PASSWORD to the password you chose"
echo "   - Then restart: docker compose restart payment"
echo ""
echo "2. SET UP DOMAIN (optional but recommended):"
echo "   Point these DNS A records to this server:"
echo "     relay.twatter.com"
echo "     media.twatter.com"
echo "     payments.twatter.com"
echo ""
echo "3. SET UP SSL (after DNS is pointing here):"
echo "   apt install certbot -y"
echo "   certbot certonly --standalone -d relay.twatter.com -d media.twatter.com -d payments.twatter.com"
echo "   cp /etc/letsencrypt/live/relay.twatter.com/fullchain.pem $PROJECT_DIR/deploy/certs/"
echo "   cp /etc/letsencrypt/live/relay.twatter.com/privkey.pem $PROJECT_DIR/deploy/certs/"
echo "   docker compose restart nginx"
echo ""
echo "4. DEPLOY WEB CLIENT:"
echo "   Push to GitHub, then import in Vercel (vercel.com)"
echo "   Set env var: VITE_PAYMENT_SERVER=https://payments.twatter.com"
echo ""
echo "5. FIREWALL:"
echo "   ufw allow 22,80,443,7777,8080/tcp"
echo "   ufw enable"
echo ""
echo "========================================"
echo "   Your relay: ws://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP'):7777"
echo "   Alby Hub:   http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP'):8080"
echo "========================================"
