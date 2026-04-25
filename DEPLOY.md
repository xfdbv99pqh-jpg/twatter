# Twatter Deployment Guide v2.0 — Lightning Edition

## Architecture Overview

```
Users
  |
  +-- Web Browser --> Vercel (free static hosting)
  +-- Desktop App --> Electron (local, connects to relay)
  |
  +-- Any Nostr Client (Damus, Amethyst, Primal, etc.)
          |
          v
+---------------------------------------------------+
|              Your VPS ($5-12/mo)                  |
|                                                   |
|  +---------+  +-------+  +----------+  +-------+ |
|  |  Relay  |  | Media |  | Payment  |  | Alby  | |
|  | :7777   |  | :7778 |  | :7779    |  | Hub   | |
|  |WebSocket|  | Images|  | Lightning|  | :8080 | |
|  +----+----+  +---+---+  +----+-----+  +---+---+ |
|       +----------++-----------+-------------+     |
|                  ||                               |
|             +----++----+                          |
|             |  Nginx   |                          |
|             | :80/:443 |                          |
|             +----------+                          |
+---------------------------------------------------+

Alby Hub = your self-custodial Lightning node
No KYC. No middleman. You hold the keys.
```

## What You Need

1. **A VPS** -- DigitalOcean, Hetzner, or OVH ($5-12/month)
2. **A domain name** -- e.g. twatter.com (optional but recommended)
3. **A Vercel account** -- free at https://vercel.com (for the web client)

That's it. Alby Hub runs as part of your Docker stack — no separate signup needed.

## Step 1: Alby Hub (Lightning Payments)

Alby Hub is a self-custodial Lightning node that runs right on your server. No KYC, no third-party custody. You hold the keys to your Bitcoin.

### How it works

Alby Hub runs as a Docker container alongside your other services. On first launch, you open its web UI to set a password and connect to the Lightning network.

### First-time setup (after docker compose up)

1. Open `http://YOUR_SERVER_IP:8080` in your browser
2. Set a password — this becomes your `ALBYHUB_PASSWORD`
3. Follow the setup wizard to connect to the Lightning network
4. Fund your node with some sats (you need inbound liquidity to receive payments)

### Getting inbound liquidity

To receive Lightning payments, your node needs inbound liquidity. Options:
- **Alby channels** — Alby Hub can open a channel for you during setup
- **Deezy / Magma** — buy inbound liquidity
- **Loop In** — submarine swap from on-chain BTC

Save your password — you will need it in Step 3.

## Step 2: Get a VPS

### Recommended: Hetzner ($5/mo)

1. Sign up at https://www.hetzner.com/cloud
2. Create a server: Ubuntu 22.04, CX22 (2 vCPU, 4GB RAM)
3. Add your SSH key
4. Note the server IP address

### Connect to your server

```bash
ssh root@YOUR_SERVER_IP
```

### Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

## Step 3: Deploy the Backend

### Upload your project to the server

From your local machine:
```bash
# From the twatter project directory
scp -r deploy/ relay/ media-server/ payment-server/ root@YOUR_SERVER_IP:/opt/twatter/
```

### Configure environment

```bash
ssh root@YOUR_SERVER_IP
cd /opt/twatter/deploy

# Create your .env file
cp .env.example .env
nano .env
```

Fill in your values:
```
CLIENT_URL=https://twatter.com
MEDIA_BASE_URL=https://media.twatter.com
ALBYHUB_URL=http://albyhub:8080
ALBYHUB_PASSWORD=the_password_you_set_in_step_1
PRO_PRICE_SATS=21000
PRO_DURATION_DAYS=30
```

### Start everything

```bash
cd /opt/twatter/deploy
docker compose up -d
```

This starts all 5 services: Alby Hub, relay, media server, payment server, and nginx.

### Verify it is running

```bash
# Check all containers are healthy
docker compose ps

# Test the relay
curl http://localhost:7777/

# Test the payment server
curl http://localhost:7779/health

# Test the media server
curl http://localhost:7778/health
```

## Step 4: Set Up Your Domain (Optional but Recommended)

### DNS Records

Point these to your server IP:
```
A    twatter.com          -> YOUR_SERVER_IP
A    relay.twatter.com    -> YOUR_SERVER_IP
A    media.twatter.com    -> YOUR_SERVER_IP
A    payments.twatter.com -> YOUR_SERVER_IP
```

### SSL Certificates (Let's Encrypt)

```bash
# Install certbot
apt install certbot -y

# Get certificates
certbot certonly --standalone -d relay.twatter.com -d media.twatter.com -d payments.twatter.com

# Copy certs to deploy directory
cp /etc/letsencrypt/live/relay.twatter.com/fullchain.pem /opt/twatter/deploy/certs/
cp /etc/letsencrypt/live/relay.twatter.com/privkey.pem /opt/twatter/deploy/certs/

# Restart nginx to pick up certs
docker compose restart nginx
```

Then update nginx.conf to add SSL listeners on port 443.

## Step 5: Deploy the Web Client (Vercel)

1. Push your project to GitHub
2. Go to https://vercel.com and import the repository
3. Vercel auto-detects Vite -- just click Deploy
4. Set the custom domain in Vercel dashboard

### Important: Update the relay URL in the client

In src/twatter.jsx, update DEFAULT_RELAYS to include your relay:
```javascript
const DEFAULT_RELAYS = [
  "wss://relay.twatter.com",    // Your relay
  "wss://relay.damus.io",       // Public fallback
  "wss://nos.lol",
];
```

Also update PAYMENT_SERVER for production:
```javascript
const PAYMENT_SERVER = import.meta.env.VITE_PAYMENT_SERVER || "https://payments.twatter.com";
```

Set the environment variable in Vercel:
- VITE_PAYMENT_SERVER = https://payments.twatter.com

## Step 6: Build the Desktop App (Optional)

### Prerequisites
```bash
npm install
```

### Build for your platform
```bash
# Windows
npm run electron-win

# macOS
npm run electron-mac

# Linux
npm run electron-linux
```

The built app appears in the release/ directory.

### Development mode
```bash
# Start the Vite dev server first
npm run dev

# In another terminal, start Electron
npm run electron-dev
```

## How Payments Work

1. User clicks "Upgrade to Pro" in the client
2. Client sends their Nostr pubkey to your payment server
3. Payment server creates a Lightning invoice via Alby Hub (21,000 sats)
4. Client shows the invoice — if the user has Alby extension, it auto-pays via WebLN
5. Otherwise, user copies the bolt11 invoice and pays from any Lightning wallet
6. Payment server polls Alby Hub every 30 seconds to check for payment
7. When paid, the user gets Pro status for 30 days
8. Pro status is checked by the relay for higher post limits

### Revenue

All Lightning payments go directly to your Alby Hub node — you hold the keys. You can send sats to any Lightning wallet, open channels, or swap to on-chain Bitcoin anytime through the Alby Hub dashboard at :8080.

## Scaling Roadmap

### Stage 1: Launch (0-1,000 users) -- ~$5/mo
- Single VPS with Docker Compose
- Alby Hub on the same server
- Vercel free tier for the web client

### Stage 2: Growth (1,000-10,000 users) -- ~$20/mo
- Upgrade VPS to 4 vCPU / 8GB RAM
- Add CDN for media (Cloudflare, free tier)
- More Lightning channels for liquidity

### Stage 3: Scale (10,000-100,000 users) -- ~$50-100/mo
- Separate servers for relay and media
- Multiple relay instances behind a load balancer
- Object storage (S3/Backblaze) for media
- Dedicated server for Alby Hub with more channels

### Stage 4: Big (100,000+ users)
- Kubernetes or similar orchestration
- PostgreSQL instead of SQLite for relay
- Multiple geographic relay locations
- Premium Lightning infrastructure

## Quick Reference

### Docker commands
```bash
cd /opt/twatter/deploy

# Start everything
docker compose up -d

# View logs
docker compose logs -f relay
docker compose logs -f payment

# Restart a service
docker compose restart relay

# Stop everything
docker compose down

# Rebuild after code changes
docker compose up -d --build
```

### Check Pro subscriber count
```bash
curl http://localhost:7779/health
```

### Check if a pubkey is Pro
```bash
curl http://localhost:7779/pro/PUBKEY_HEX_HERE
```

## Troubleshooting

### "Lightning payments not configured"
- Make sure ALBYHUB_PASSWORD is set in your .env file
- Check Alby Hub is running: docker compose logs albyhub
- Restart the payment container: docker compose restart payment

### Relay not accepting connections
- Check firewall: ufw allow 80,443,7777,8080/tcp
- Check logs: docker compose logs relay

### Media uploads failing
- Check disk space: df -h
- Check the upload directory has space in the Docker volume

### Invoice not being detected as paid
- The payment server polls Alby Hub every 30 seconds
- Check payment server logs: docker compose logs payment
- Check Alby Hub dashboard at :8080 to see if the invoice shows up
- Make sure your node has inbound liquidity to receive payments

### Alby Hub not starting
- Check logs: docker compose logs albyhub
- Make sure port 8080 is not in use by something else
- The albyhub-data volume stores your keys — never delete it
