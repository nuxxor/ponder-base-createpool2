# Ponder Base Token Sniper

Real-time token sniper bot for Base blockchain. Detects new token launches on Clanker and Zora platforms within seconds, validates creator quality, and optionally executes automatic purchases.

## Features

- **Real-time Detection**: WebSocket connection to local Base node for ~0ms latency
- **Factory Monitoring**: Direct event subscription to Clanker and Zora factories
- **Creator Validation**: Twitter followers (70K+) and Farcaster followers (10K+) checks
- **Instant Alerts**: Telegram notifications within 2-3 seconds of token creation
- **Auto-Buy Module**: Automatic token purchases via Uniswap V3/V4
- **Backup Monitor**: Polling-based monitor for comprehensive token tracking

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│           FULL NODE WebSocket (localhost:18546)             │
│                    ~0ms latency                             │
└─────────────────────────────┬───────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │  Clanker    │    │    Zora     │    │  Uniswap/   │
    │  Factory    │    │   Factory   │    │  Aerodrome  │
    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘
           │                  │                  │
           └──────────────────┴──────────────────┘
                              │
                        Pool Created!
                              │
                              ▼
                 ┌────────────────────────┐
                 │  Parallel Validation   │
                 │  • Clanker API lookup  │
                 │  • Neynar score check  │
                 │  (~500ms)              │
                 └────────────┬───────────┘
                              │
                              ▼
                 ┌────────────────────────┐
                 │   TELEGRAM ALERT       │
                 │   + Auto-buy (V3/V4)   │
                 └────────────────────────┘

               TOTAL: ~2-3 seconds
```

## Factory Addresses

| Platform | Factory Contract |
|----------|------------------|
| Clanker V4 | `0xE85A59c628F7d27878ACeB4bf3b35733630083a9` |
| Zora | `0x777777751622c0d3258f214F9DF38E35BF45baF3` |
| Uniswap V2 | `0x8909dc15e40173ff4699343b6eb8132c65e18ec6` |
| Uniswap V3 | `0x33128a8fc17869897dce68ed026d694621f6fdfd` |
| Aerodrome V2 | `0x420dd381b31aef6683db6b902084cb0ffece40da` |
| Aerodrome CL | `0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a` |

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your API keys

# Run sniper bot (real-time, recommended)
npm run sniper

# Optional: run monitor (polling-based backup). If you run both, disable monitor Telegram to avoid duplicates:
# MONITOR_TELEGRAM_ENABLED=false
npm run monitor
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run sniper` | **Real-time sniper bot** - WebSocket event listener |
| `npm run monitor` | Polling-based monitor (1 min interval) |
| `npm run dev` | Ponder indexer (development) - not required for sniper/monitor |
| `npm run start` | Ponder indexer (production) |
| `npm run poll:launchpads` | One-off Clanker/Zora fetch |

## Configuration

### Required Environment Variables

```bash
# RPC (local full node)
PONDER_RPC_URL_8453=http://127.0.0.1:18545
WS_RPC_URL=ws://127.0.0.1:18546

# Telegram Alerts
TELEGRAM_BOT_TOKEN=your_bot_token
BASE_DEGEN_ALARM=your_chat_id

# API Keys
NEYNAR_API_KEY=your_key
CLANKER_API_KEY=your_key
ZORA_API_KEY=your_key
TWITTER_API_KEY=your_key
```

### Validation Thresholds

```bash
# Minimum requirements for alerts
MIN_NEYNAR_SCORE=0.55              # 55% Neynar reputation
PROMISING_TWITTER_MIN_FOLLOWERS=5000
PROMISING_FARCASTER_MIN_FOLLOWERS=2000
```

### Speed Settings

```bash
# Sniper uses WebSocket (instant)
# Monitor uses polling:
POLL_INTERVAL_MS=60000              # 1 minute
EXTERNAL_REFRESH_INTERVAL_MS=60000  # 1 minute
DEXSCREENER_REQUEST_DELAY_MS=500    # 500ms between requests
```

## How It Works

### 1. Sniper Bot (`src/sniper.ts`)

The sniper bot connects directly to your local Base node via WebSocket and subscribes to factory contract events:

```
Event Detected → Creator Lookup → Neynar Validation → Telegram Alert
     0ms            ~200ms           ~300ms              ~100ms
                                                    ─────────────
                                                    Total: ~600ms
```

**Flow:**
1. WebSocket subscription to Clanker/Zora factory addresses
2. On `TokenCreated` or `CoinCreated` event:
   - Extract token address and creator
   - Query Clanker API for creator FID
   - Check Neynar score (cached 6h)
   - If passes thresholds → Send Telegram alert

### 2. Monitor (`src/monitor.ts`)

Backup polling-based system that also tracks token health over time:

```
Poll Clanker/Zora → Add to Watchlist → Check Dexscreener → Evaluate Health
      ↓                                      ↓
  Every 1 min                          Liquidity, Volume,
                                       Buy/Sell ratio
                                              ↓
                                    Social Gate Check
                                              ↓
                                    Telegram + Promising.json
```

**Features:**
- Tracks consecutive healthy cycles
- Security checks (owner renounced, LP locked)
- Drops tokens that fail health metrics
- Maintains historical snapshots

### 3. Telegram Notifications (`src/services/telegram.ts`)

Sends formatted alerts to your Telegram channel:

```
🚨 NEW PROMISING TOKEN

Token: 0x...
Symbol: EXAMPLE
Platform: clanker

📊 Metrics:
• Liquidity: $50,000
• Volume 24h: $25,000
• Buys/Sells 1h: 45/12

👤 Social:
• Neynar Score: 78%
• Farcaster: 5,000 followers
• Creator FID: 12345

🔗 Links:
DexScreener | Basescan
```

## Project Structure

```
ponder-base-createpool2/
├── src/
│   ├── sniper.ts           # 🎯 Real-time sniper bot (NEW)
│   ├── monitor.ts          # Polling-based monitor + Telegram
│   ├── services/
│   │   └── telegram.ts     # 📱 Telegram notification service (NEW)
│   ├── index.ts            # Ponder event handlers
│   ├── constants.ts        # Thresholds and config
│   ├── env.ts              # Environment loader
│   ├── dexscreener.ts      # Dexscreener API client
│   ├── basescan.ts         # BaseScan API client
│   ├── connectors/
│   │   ├── clanker.ts      # Clanker API
│   │   ├── zora.ts         # Zora API
│   │   └── farcaster.ts    # Farcaster API
│   ├── pipelines/
│   │   └── launchpads.ts   # External source polling
│   ├── utils/
│   │   ├── watchlist.ts    # Token watchlist management
│   │   ├── promising.ts    # Promising tokens store
│   │   ├── socialProof.ts  # Social validation gates
│   │   └── scoring.ts      # Token scoring
│   └── api/
│       └── index.ts        # GraphQL/SQL API
├── data/
│   ├── watchlist.json      # Active token tracking
│   ├── dex_snapshots.ndjson # Historical metrics
│   └── promising.json      # Qualified tokens
├── ponder.config.ts        # Chain/contract config
└── ponder.schema.ts        # Database schema
```

## Validation Criteria

A token passes validation if the creator meets:

| Criteria | Threshold | Source |
|----------|-----------|--------|
| Neynar Score | ≥ 55% | Neynar API |
| Farcaster Followers | ≥ 2,000 | Farcaster API |
| Twitter Followers | ≥ 5,000 | Twitter API |

Health metrics for monitor:

| Metric | Threshold |
|--------|-----------|
| Liquidity | ≥ $15,000 |
| Buys/Hour | ≥ 10 |
| Buy/Sell Ratio | ≥ 0.65 |
| Volume 1h | ≥ $10,000 |

## Running with Local Node

For minimum latency, run a local Base node:

```bash
# Check node sync status
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_syncing","params":[],"id":1}' \
  http://127.0.0.1:18545

# Check current block
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://127.0.0.1:18545
```

**RPC Ports:**
- HTTP: `127.0.0.1:18545`
- WebSocket: `127.0.0.1:18546`

## Auto-Buy Module

Automatic token purchases when signals pass validation.

### Configuration

```bash
# .env.local

# Auto-buy wallet (KEEP SECRET!)
AUTOBUY_PRIVATE_KEY=0x...your_private_key

# Enable auto-buy
AUTOBUY_ENABLED=true

# Buy settings
AUTOBUY_AMOUNT_ETH=0.01          # ETH per trade
AUTOBUY_MAX_DAILY_ETH=0.5        # Daily spending limit
AUTOBUY_SLIPPAGE_PERCENT=10      # Slippage tolerance
AUTOBUY_GAS_PRIORITY_GWEI=0.1    # Priority fee

# Safety
AUTOBUY_MIN_LIQUIDITY_USD=5000   # Min liquidity before buy
```

### How It Works

1. Token passes validation (Twitter 70K+ or Farcaster 10K+)
2. Liquidity check passes ($5K minimum)
3. Auto-buy executes swap via:
   - **Clanker**: Uniswap V3 SwapRouter02
   - **Zora**: Uniswap V4 (with V3 fallback)
4. Telegram notification sent with trade details

### Trade Flow

```
Signal Detected → Validation → Liquidity OK? → AUTO-BUY
                                                 │
                              ┌──────────────────┴──────────────────┐
                              ▼                                     ▼
                       Clanker (V3)                            Zora (V4)
                              │                                     │
                              └──────────────────┬──────────────────┘
                                                 ▼
                                         WETH → Token Swap
                                                 │
                                                 ▼
                                        Telegram Notification
```

### Safety Features

- Daily spending limit (default 0.5 ETH)
- Minimum liquidity check before buy
- Slippage protection (10% default)
- Trade logging to `data/trades.jsonl`

### Quick Start (Auto-Buy)

```bash
# 1. Generate a NEW wallet for trading (don't use main wallet!)
#    Use MetaMask or any wallet to create a fresh address

# 2. Add private key to .env.local
echo 'AUTOBUY_PRIVATE_KEY=0x...your_key' >> .env.local

# 3. Fund the wallet with ETH on Base
#    Send 0.1-0.5 ETH for testing

# 4. Enable auto-buy
echo 'AUTOBUY_ENABLED=true' >> .env.local

# 5. Start sniper
npm run sniper

# You should see:
# [sniper] 🛒 AUTO-BUY: ENABLED
# [sniper]    Wallet: 0x...
# [sniper]    Balance: 0.1 ETH
```

### Telegram Notifications

When auto-buy executes, you'll receive:
```
✅ AUTO-BUY EXECUTED

Token: 0x1234...abcd
Symbol: $EXAMPLE
Platform: clanker

💰 Trade:
• Spent: 0.01 ETH
• Received: 1,234,567 tokens

🔗 Basescan | DexScreener
```

## Roadmap

- [x] WebSocket event listener
- [x] Clanker/Zora factory monitoring
- [x] Neynar score validation
- [x] Telegram notifications
- [x] Auto-buy module (Uniswap V3/V4)
- [x] Slippage protection
- [ ] Mempool monitoring (pre-block detection)
- [ ] Multi-wallet support
- [ ] Auto-sell on profit target
- [ ] Honeypot pre-check

## Latency Comparison

| Method | Detection Time |
|--------|---------------|
| Sniper (WebSocket) | **~2-3 seconds** |
| Monitor (Polling) | ~1-2 minutes |
| External APIs only | ~5+ minutes |

## Disk Migration Plan (Hetzner +2TB SSD)

When new disk arrives, follow this plan for zero data loss:

### Current Status
```
Disk: 7TB (98% full, 185GB free)
Base Node: 5.2TB (61% synced)
Needed: +2TB minimum
```

### Migration Steps

```bash
# 1. Find new disk (after Hetzner installs it)
lsblk

# 2. Create partition on NEW disk only
fdisk /dev/nvme4n1   # or whatever name it gets
# -> n (new), p (primary), 1, Enter, Enter, w (write)

# 3. Format NEW disk only (existing disks untouched!)
mkfs.ext4 /dev/nvme4n1p1

# 4. Create mount point
mkdir -p /mnt/base-data

# 5. Mount new disk
mount /dev/nvme4n1p1 /mnt/base-data

# 6. Add to fstab (persistent mount)
echo "/dev/nvme4n1p1 /mnt/base-data ext4 defaults 0 2" >> /etc/fstab

# 7. First rsync - NODE KEEPS RUNNING (takes 4-6 hours)
rsync -avP /opt/base-node/data/ /mnt/base-data/

# 8. Stop node for final sync (only ~15 min downtime)
systemctl stop base-reth

# 9. Final rsync - only changes
rsync -avP --delete /opt/base-node/data/ /mnt/base-data/

# 10. Create symlink
mv /opt/base-node/data /opt/base-node/data.old
ln -s /mnt/base-data /opt/base-node/data

# 11. Start node
systemctl start base-reth

# 12. Verify it works, then delete old data
# rm -rf /opt/base-node/data.old  # ONLY after confirming!
```

### Timeline
| Step | Duration | Node Status |
|------|----------|-------------|
| Hetzner installs disk | ~1 hour | ⏸️ Down |
| Format + Mount | 5 min | ✅ Running |
| First rsync (background) | 4-6 hours | ✅ Running |
| Final rsync + symlink | 15-20 min | ⏸️ Down |
| **Total node downtime** | **~15-20 min** | - |

### Important Notes
- Existing RAID disks are NOT touched
- Only the new disk gets formatted
- Node continues syncing during migration
- No data loss - node resumes from where it stopped

## License

MIT
