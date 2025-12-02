# Ponder Base CreatePool Monitor

Dex pool creation indexer + off-chain monitor for Base. Tracks Uniswap V2/V3 and Aerodrome V2/Slipstream pool creations, seeds a watchlist of novel tokens, polls Dexscreener for liquidity/flow/price signals, enforces social gates, and emits “promising” tokens for follow-up.

## What this repo does
- **Index pool creations** via Ponder from Base factories (Uni V2/V3, Aerodrome V2/CL) into the `pool_creation` table (schema in `ponder.schema.ts`).
- **Detect novel tokens** against anchor tokens (WETH/USDC/USDbC + optional extras/Virtuals), then add them to a JSON watchlist with pool/quote metadata.
- **Poll Dexscreener** for each active token, aggregate liquidity/volume/txn counts/price change, evaluate health, and drop or keep tokens with streak tracking.
- **Enforce social gates** (Twitter + optional Farcaster + creator verification via Clanker/Zora/Neynar) before marking a token as “promising”.
- **Check security** via BaseScan: owner() renounce check and LP lock heuristics (burn/locker destinations) for V2 pools.
- **Poll launchpads** (Clanker + Zora) to ingest fresh candidates and precompute scores.
- **Expose APIs** through Hono + Ponder’s built-in SQL/GraphQL routes.

## Stack
- Ponder (`ponder.config.ts`, `src/index.ts`) for on-chain indexing
- TypeScript, viem for RPC
- Hono for API surface
- File-backed state under `data/` (`watchlist.json`, `dex_snapshots.ndjson`, `promising.json`)

## Data & Schema
- **Table** `pool_creation` (`ponder.schema.ts`): id, protocol, factoryAddress, transactionHash, blockNumber, blockTimestamp, logIndex, token0/1, poolAddress, stable?, feeTier?, tickSpacing?, poolSequence?.
- **Watchlist** (`data/watchlist.json`): tokens keyed by address, with status, pools, quoteTokens, identity, community, security, metrics snapshots, scores, notes.
- **Snapshots** (`data/dex_snapshots.ndjson`): append-only JSON lines of metrics + evaluation decisions per cycle.
- **Promising** (`data/promising.json`): tokens that pass health streak + social gate, with latest metrics/evaluation/community.

## Key flows
### On-chain indexing (`src/index.ts`)
1. Ponder handlers subscribe to:
   - `UniswapV2Factory:PairCreated`
   - `UniswapV3Factory:PoolCreated`
   - `AerodromeV2Factory:PoolCreated`
   - `AerodromeCLFactory:PoolCreated`
2. For each event: build payload (protocol, tokens, pool address, fee/stable/tickSpacing/sequence), insert into `pool_creation`.
3. If `ENABLE_POOL_TRACKING=true`: detect if exactly one side is an anchor token. If so, track the novel token:
   - Add/merge watchlist entry with pool/quote/factory metadata.
   - If `VIRTUAL_TOKEN_ADDRESS` is the anchor and timestamp exists, upsert Virtuals candidate with schedule metadata.

### Monitoring loop (`src/monitor.ts`)
1. Loads env + thresholds from `src/constants.ts`.
2. Periodically runs `runCycle` (interval `POLL_INTERVAL_MS` or default 5 min):
   - Refresh external sources (launchpads; see below).
   - Read active watchlist entries.
   - For each token:
     - Optionally refresh security (owner + LP lock) if stale.
     - Fetch Dexscreener pairs (`fetchPairsForToken`) and aggregate:
       liquidity USD (sum), volumes H1/H24, buys/sells H1/H24, weighted price, price change, best pair info, community links.
     - Evaluate metrics against thresholds (liquidity/flow/buy-sell ratio/momentum, drop triggers like price crash, no trades, mcap/liquidity ratio, suspicious labels). Warnings/risk flags include owner not renounced, LP unlocked.
     - Update watchlist snapshot (status active/dropped, notes, consecutive healthy cycles, last liquidity).
     - If score >= `PROMISING_SCORE_THRESHOLD` for `MIN_CONSECUTIVE_HEALTHY_CYCLES` cycles, run social gate:
       - Twitter follower min (`PROMISING_TWITTER_MIN_FOLLOWERS`)
       - Farcaster follower min (`PROMISING_FARCASTER_MIN_FOLLOWERS`) if creator FID present
       - Creator verification via Clanker + Zora + Neynar (FID alignment, verified msg_sender)
       - Optional smart follower audit via external script
     - If gate passes: upsert into promising set; else remove from promising and annotate notes.
     - Sleep `DEXSCREENER_REQUEST_DELAY_MS` between tokens.

### Launchpad ingestion (`src/pipelines/launchpads.ts`)
- Runs every `EXTERNAL_REFRESH_INTERVAL_MS` (default 5 min).
- Fetches Clanker recent tokens (`src/connectors/clanker.ts`), resolves Farcaster identity (creator, verified addresses, smart account, launch count), normalizes community/security, schedules LP deployment time.
- Fetches Zora explore list (`src/connectors/zora.ts`), enriches with Twitter (profile lookup) and smart follower hint.
- Upserts candidates into watchlist. For Clanker, precompute score (`src/utils/scoring.ts`) based on Farcaster launch count and social signals.

### Security checks (`src/basescan.ts`)
- Calls BaseScan (rate-limited) to:
  - `owner()`; marks renounced if burn/null address.
  - LP lock for V2 pools: totalSupply vs balances at known burn/locker destinations (`LOCK_DESTINATIONS`), compute locked percent + breakdown.
- V3/Slipstream pools marked as v3 (no lock math).

### Social gate (`src/utils/socialProof.ts`)
- Extract Twitter handle from identity/community links; fetch followers via `twitterapi.io`.
- If creator FID present, fetch Farcaster followers via `api.farcaster.xyz`.
- Creator verification:
  - Clanker token creator (FID, msg_sender, platform).
  - Zora coin creator Farcaster info.
  - Neynar user lookup (follower count, verified eth addresses) to confirm msg_sender.
- Enforce minimum followers; require creator alignment; optionally run smart follower audit script when passes.
- Results cached with TTLs (social stats + creator verification).

## Configuration (env)
Load order: `../ai-pipeline/.env`, `.env`, `.env.local`, optional `DOTENV_PATH`.

Common vars:
- `PONDER_RPC_URL_8453` (or fallback `https://mainnet.base.org`)
- `ENABLE_POOL_TRACKING` (true/false)
- `BASE_EXTRA_ANCHORS` (comma-separated addresses)
- `VIRTUAL_TOKEN_ADDRESS`
- `DEXSCREENER_REQUEST_DELAY_MS`, `POLL_INTERVAL_MS`
- Social: `TWITTER_API_KEY`, `FARCASTER_API_KEY`, `FARCASTER_HUB_HTTP`, `NEYNAR_API_KEY`, `CLANKER_API_KEY`, `ZORA_API_KEY`, `SMART_FOLLOWER_AUTO_RUN`, `SMART_FOLLOWER_AUTO_REFRESH_MS`, `SOCIAL_STATS_TTL_MS`
- Thresholds (override defaults in `src/constants.ts`):
  - Liquidity/flow: `MIN_HEALTHY_LIQUIDITY_USD`, `MIN_BUYS_PER_HOUR`, `MIN_BUY_SELL_RATIO`
  - Drop: `DROP_LIQUIDITY_THRESHOLD_USD`, `DROP_PRICE_CHANGE_THRESHOLD`, `LIQUIDITY_DROP_PERCENT`, `LIQUIDITY_DROP_MIN_BASE`
  - Volume: `MIN_VOLUME_H1_USD`
  - Promising: `PROMISING_SCORE_THRESHOLD`, `MIN_CONSECUTIVE_HEALTHY_CYCLES`
  - Farcaster reputation: `MIN_NEYNAR_SCORE` (default 0.55), `NEYNAR_SCORE_CACHE_TTL_MS`
  - Security: `MIN_LOCKED_LP_PERCENT`, `SECURITY_REFRESH_INTERVAL_MS`, `MAX_SECURITY_CHECKS_PER_CYCLE`
- BaseScan: `BASESCAN_API_KEY`, `BASESCAN_MIN_DELAY_MS`
- Watchlist gating: `WATCHLIST_ALLOWED_PLATFORMS` (default `zora,clanker`)
- Paths: `SMART_FOLLOWERS_PATH` (JSON cache), `WATCH_DATA_DIR`, `PROMISING_TOKENS_FILE`, etc.

## Scripts
- `npm run dev` / `npm run start`: Ponder dev/prod.
- `npm run monitor`: run Dexscreener monitor loop.
- `npm run poll:launchpads`: one-off external source refresh.
- `npm run test:social-gate`: unit test for social gate logic (uses mocked fetch).
- `npm run test:neynar-score`: fetch Neynar user score for provided FIDs.
- `npm run codegen`, `npm run lint`, `npm run typecheck`.
- Utility scripts:
  - `scripts/testRpc.ts`: RPC sanity check.
  - `scripts/checkCreator.ts`: inspect creator info via Zora + Neynar.
  - `scripts/listZoraCoins.ts`: scan ZoraFactory events on Base.

## Directory tour
- `ponder.config.ts`: chain/contract config, dynamic start block.
- `ponder.schema.ts`: DB schema for pool creations.
- `src/index.ts`: event handlers + watchlist seeding.
- `src/constants.ts`: thresholds, anchors, files, API defaults.
- `src/env.ts`: layered dotenv loader.
- `src/monitor.ts`: Dexscreener loop, evaluation, social gate, promising updates.
- `src/dexscreener.ts`: API client + aggregation + community extraction.
- `src/utils/watchlist.ts`: JSON-backed watchlist, locking, merging, snapshots, scores.
- `src/utils/promising.ts`: promising token store with pruning to watchlist.
- `src/utils/socialProof.ts`: social gate + creator verification + smart follower audit.
- `src/utils/scoring.ts`: scoring models for Clanker/Zora.
- `src/utils/smartFollowers.ts`: local smart follower cache loader.
- `src/utils/address.ts`: normalization helpers.
- `src/basescan.ts`: BaseScan helpers (owner, supply, balances, LP lock analysis).
- `src/pipelines/launchpads.ts`: external candidate ingestion + scoring.
- `src/connectors/*`: Clanker, Zora, Farcaster connectors.
- `src/api/index.ts`: Hono routes (GraphQL + SQL via Ponder).
- `scripts/*`: helper CLIs.
- `data/`: persisted state (created at runtime).

## Running locally
1. Install deps: `npm install`
2. Set env (minimal): `PONDER_RPC_URL_8453`, `TWITTER_API_KEY`, `ZORA_API_KEY`, `CLANKER_API_KEY`, `NEYNAR_API_KEY`, `FARCASTER_API_KEY`, `BASESCAN_API_KEY` (defaults exist but use your own).
3. Start indexer: `npm run dev` (Ponder UI available).
4. Run monitor loop (separate process): `npm run monitor`
5. Optional: `npm run poll:launchpads` to prefill watchlist/promising.

## Operational notes
- **Start block** is dynamic: uses latest Base block at boot; if RPC fails, falls back to `FALLBACK_START_BLOCK` (38,050,000). To backfill history, override start blocks or set a static value.
- **File locks** are ad-hoc promises to serialize writes; corrupted JSON is auto-backed up with a timestamp and recreated.
- **API quotas**: Dexscreener polling spaced by `DEXSCREENER_REQUEST_DELAY_MS`; BaseScan is throttled to ~4 req/s; external social/creator APIs may need keys/quotas.
- **LP locks** only computed for V2-style pools with known burn/locker destinations; v3/Slipstream are marked but not quantified.
- **Smart follower audit** relies on an external script at `../scripts/countSmartFollowers.js` and dataset `../smart_followers_master.json` unless overridden.

## Extending
- Add more factories: extend `ponder.config.ts` + handlers in `src/index.ts`.
- Adjust health thresholds: tweak `src/constants.ts` or env overrides.
- Enrich social gate: plug new providers into `src/utils/socialProof.ts`.
- Add dashboards: consume `data/dex_snapshots.ndjson` and `promising.json`.
