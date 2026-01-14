/**
 * SNIPER BOT - Real-time token detection
 *
 * Listens to Clanker and Zora factory events via WebSocket
 * Validates creator quality in parallel
 * Sends Telegram alert within 2-3 seconds of token creation
 */

import "./env";
import { createPublicClient, webSocket, parseAbiItem, type Log } from "viem";
import { base } from "viem/chains";
import { sendTelegramAlert, sendSimpleMessage, TokenAlert } from "./services/telegram";
import { fetchPairsForToken, aggregateTokenMetrics } from "./dexscreener";
import { executeBuy, isAutoBuyReady, getWalletInfo, BuyRequest } from "./services/autobuy";
import { LRUCache } from "./utils/lruCache";
import { guardedFetch } from "./utils/http";
import * as fs from "fs";
import * as path from "path";

// ============= CONFIGURATION =============

const WS_RPC_URL = process.env.WS_RPC_URL || "ws://127.0.0.1:28546";

// Factory addresses
const CLANKER_FACTORY = "0xE85A59c628F7d27878ACeB4bf3b35733630083a9";
const ZORA_FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3";

// VIP Zora accounts - their content/post coins (CoinCreatedV4) are also tracked
// These are high-profile accounts whose posts are worth sniping
const ZORA_VIP_ADDRESSES = new Set([
  "0x9652721d02b9db43f4311102820158abb4ecc95b", // @base (mint.base.eth)
  "0x3092dd07eb967c8f155c958a12dd5c75de650921", // @base alt
  "0x19ff7ea0badffa183f03533c3884f9ca03145aad", // @base alt
  "0x17cd072cbd45031efc21da538c783e0ed3b25dcc", // @jacob (jacob.eth)
  "0x4e1749017f9d36c2c8b96a5d662118c42dbdc1a5", // @jacob alt
  "0x3a5df03dd1a001d7055284c2c2c147cbbc78d142", // @jacob alt
  "0xf9fcd1fa7a5a3f2cf6fe3a33e1262b74c04feeda", // @zora (imagine.zora.eth)
  "0x7305de32957602344486a1016ecc4314da23d46b", // @zora alt
  "0x70211a4c59fb9340bdb646a567f78d425f62da3c", // @zora alt
]);

// Neynar API
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const NEYNAR_API_URL = "https://api.neynar.com/v2/farcaster/user/bulk";
const NEYNAR_API_HOST = new URL("https://api.neynar.com").host;
const NEYNAR_CONCURRENCY = Number(process.env.NEYNAR_CONCURRENCY ?? 4);
const NEYNAR_TIMEOUT_MS = Number(process.env.NEYNAR_TIMEOUT_MS ?? 10_000);
const SNIPER_NEYNAR_ADDRESS_CACHE_TTL_MS = Number(
  process.env.SNIPER_NEYNAR_ADDRESS_CACHE_TTL_MS ?? 10 * 60 * 1000,
);
const SNIPER_NEYNAR_NOT_FOUND_CACHE_TTL_MS = Number(
  process.env.SNIPER_NEYNAR_NOT_FOUND_CACHE_TTL_MS ?? 60 * 1000,
);

// Zora API
const ZORA_API_KEY = process.env.ZORA_API_KEY;
const ZORA_API_BASE =
  (process.env.ZORA_API_BASE ?? "https://api-sdk.zora.engineering").replace(
    /\/$/,
    ""
  );
const ZORA_API_BASE_FALLBACK = (
  process.env.ZORA_API_BASE_FALLBACK ?? "https://api-sdk.zora.co"
).replace(/\/$/, "");
const ZORA_CONCURRENCY = Number(process.env.ZORA_CONCURRENCY ?? 4);
const ZORA_TIMEOUT_MS = Number(process.env.ZORA_TIMEOUT_MS ?? 10_000);
const ZORA_HOST_KEY = "zora-api";

// Clanker API for creator lookup
const CLANKER_API_URL = "https://www.clanker.world/api/tokens";
const CLANKER_API_HOST = new URL(CLANKER_API_URL).host;
const CLANKER_CONCURRENCY = Number(process.env.CLANKER_CONCURRENCY ?? 4);
const CLANKER_TIMEOUT_MS = Number(process.env.CLANKER_TIMEOUT_MS ?? 10_000);

// Minimum thresholds - STRICT MODE
const MIN_NEYNAR = 0.90; // 90% Neynar score required
const MIN_TWITTER_FOLLOWERS = 70000; // 70K Twitter followers (for "big account" pass)
const MIN_TWITTER_MINIMUM = 5000; // 5K Twitter minimum (must have at least this)
const MIN_FARCASTER_FOLLOWERS = 10000; // 10K Farcaster followers

const SNIPER_NEYNAR_GATE_ENABLED =
  String(process.env.SNIPER_NEYNAR_GATE_ENABLED ?? "false").toLowerCase() ===
  "true";
const SNIPER_MIN_NEYNAR_SCORE = Math.max(
  0,
  Math.min(1, Number(process.env.SNIPER_MIN_NEYNAR_SCORE ?? MIN_NEYNAR)),
);

// Liquidity watchlist config
const MIN_LIQUIDITY_USD = 5000; // $5K minimum liquidity to send alert
const WATCHLIST_CHECK_INTERVAL_MS = 10000; // Check every 10 seconds
const WATCHLIST_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour max watch time

const SNIPER_FAST_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.SNIPER_FAST_TIMEOUT_MS ?? 2500),
);

const SNIPER_ALERT_ON_CREATE =
  String(process.env.SNIPER_ALERT_ON_CREATE ?? "true").toLowerCase() === "true";
const SNIPER_ALERT_ON_LIQUIDITY =
  String(process.env.SNIPER_ALERT_ON_LIQUIDITY ?? "true").toLowerCase() ===
  "true";
const SNIPER_LIQUIDITY_ALERT_AFTER_CREATE =
  String(process.env.SNIPER_LIQUIDITY_ALERT_AFTER_CREATE ?? "false").toLowerCase() ===
  "true";
const SNIPER_ENABLE_SLOW_FALLBACK =
  String(process.env.SNIPER_ENABLE_SLOW_FALLBACK ?? "true").toLowerCase() ===
  "true";
const SNIPER_SLOW_VALIDATION_CONCURRENCY = Math.max(
  1,
  Number(process.env.SNIPER_SLOW_VALIDATION_CONCURRENCY ?? 2),
);

const SNIPER_EVENT_STALE_THRESHOLD_MS = Math.max(
  0,
  Number(process.env.SNIPER_EVENT_STALE_THRESHOLD_MS ?? 10 * 60 * 1000),
);
const SNIPER_STALE_WARNING_INTERVAL_MS = Math.max(
  0,
  Number(process.env.SNIPER_STALE_WARNING_INTERVAL_MS ?? 5 * 60 * 1000),
);
const SNIPER_RESUBSCRIBE_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.SNIPER_RESUBSCRIBE_COOLDOWN_MS ?? 10 * 60 * 1000),
);
const SNIPER_STALE_PROBE_INTERVAL_MS = Math.max(
  0,
  Number(process.env.SNIPER_STALE_PROBE_INTERVAL_MS ?? 5 * 60 * 1000),
);
const SNIPER_STALE_PROBE_BLOCKS = BigInt(
  Math.max(0, Number(process.env.SNIPER_STALE_PROBE_BLOCKS ?? 500)),
);

// Concurrency controls (tune for speed vs API limits)
const SNIPER_EVENT_CONCURRENCY = Math.max(
  1,
  Number(process.env.SNIPER_EVENT_CONCURRENCY ?? 4),
);
const WATCHLIST_DEX_CONCURRENCY = Math.max(
  1,
  Number(process.env.SNIPER_WATCHLIST_CONCURRENCY ?? 4),
);

// Guardrails: cursor persistence + event dedup
const SNIPER_DATA_DIR = path.resolve(process.cwd(), process.env.SNIPER_DATA_DIR ?? "data");
const SNIPER_CURSOR_PATH = path.join(
  SNIPER_DATA_DIR,
  process.env.SNIPER_CURSOR_FILE ?? "sniper_cursor.json",
);
const SNIPER_CURSOR_FLUSH_MS = Number(
  process.env.SNIPER_CURSOR_FLUSH_MS ?? 5000,
);
const SNIPER_ENABLE_BACKFILL =
  String(process.env.SNIPER_ENABLE_BACKFILL ?? "true").toLowerCase() ===
  "true";
const SNIPER_BACKFILL_BLOCKS = BigInt(
  Math.max(0, Number(process.env.SNIPER_BACKFILL_BLOCKS ?? 50)),
);
const SNIPER_BACKFILL_MAX_LOGS = Math.max(
  0,
  Number(process.env.SNIPER_BACKFILL_MAX_LOGS ?? 200),
);
const SNIPER_DEDUP_TTL_MS = Number(
  process.env.SNIPER_DEDUP_TTL_MS ?? 30 * 60 * 1000,
);

type SniperCursorState = {
  lastSeenBlock?: string;
  updatedAt?: string;
};

let sniperLastSeenBlock: bigint | null = null;
let sniperCursorDirty = false;

const ensureSniperDataDir = async () => {
  await fs.promises.mkdir(SNIPER_DATA_DIR, { recursive: true });
};

const readSniperCursor = async (): Promise<bigint | null> => {
  try {
    const raw = await fs.promises.readFile(SNIPER_CURSOR_PATH, "utf8");
    const parsed = JSON.parse(raw) as SniperCursorState;
    const value = parsed.lastSeenBlock;
    if (!value) return null;
    const block = BigInt(value);
    return block >= 0n ? block : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.warn(
      "[sniper] Failed to read cursor file, starting without backfill:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};

const writeSniperCursor = async (block: bigint) => {
  await ensureSniperDataDir();
  const payload: SniperCursorState = {
    lastSeenBlock: block.toString(),
    updatedAt: new Date().toISOString(),
  };
  const tmpPath = `${SNIPER_CURSOR_PATH}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  await fs.promises.writeFile(
    tmpPath,
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  await fs.promises.rename(tmpPath, SNIPER_CURSOR_PATH);
};

const markSniperCursor = (block: bigint | undefined | null) => {
  if (!block) return;
  if (sniperLastSeenBlock === null || block > sniperLastSeenBlock) {
    sniperLastSeenBlock = block;
    sniperCursorDirty = true;
  }
};

const flushSniperCursor = async () => {
  if (!sniperCursorDirty) return;
  if (sniperLastSeenBlock === null) return;
  sniperCursorDirty = false;
  try {
    await writeSniperCursor(sniperLastSeenBlock);
  } catch (error) {
    sniperCursorDirty = true;
    console.warn(
      "[sniper] Failed to write cursor file:",
      error instanceof Error ? error.message : error,
    );
  }
};

const getEventId = (log: Log): string => {
  const anyLog = log as any;
  const txHash = String(log.transactionHash ?? anyLog.transactionHash ?? "unknown");
  const logIndex =
    anyLog.logIndex ?? anyLog.index ?? anyLog.log?.logIndex ?? "unknown";
  const address = String(log.address ?? anyLog.address ?? "").toLowerCase();
  return `${txHash}:${String(logIndex)}:${address}`;
};

const processedEventIds = new LRUCache<string, true>(
  50_000,
  SNIPER_DEDUP_TTL_MS,
);

const SNIPER_CREATE_ALERT_DEDUP_TTL_MS = Number(
  process.env.SNIPER_CREATE_ALERT_DEDUP_TTL_MS ?? 6 * 60 * 60 * 1000,
);
const createAlertedTokens = new LRUCache<string, true>(
  50_000,
  SNIPER_CREATE_ALERT_DEDUP_TTL_MS,
);

const shouldRetryHttp = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error instanceof Error && /^HTTP (429|5\\d\\d)\\b/.test(error.message)) {
    return true;
  }
  return false;
};

const shouldWatchLiquidity = (): boolean => {
  // Always watch liquidity if we'll alert on it, or if auto-buy needs the signal.
  return SNIPER_ALERT_ON_LIQUIDITY || isAutoBuyReady().ready;
};

// API Health tracking
let zoraApiHealthy = true;
let zoraApiLastCheck = 0;
let zoraApiLastHealthyAt = Date.now();
const ZORA_HEALTH_CHECK_INTERVAL_MS = 30000; // Check health every 30s

// Check Zora API health by making a simple request
async function checkZoraApiHealth(): Promise<boolean> {
  const now = Date.now();
  // Don't check too frequently
  if (now - zoraApiLastCheck < ZORA_HEALTH_CHECK_INTERVAL_MS) {
    return zoraApiHealthy;
  }
  zoraApiLastCheck = now;

  try {
    // Use a known token to check API health
    const url = new URL("/coin", ZORA_API_BASE);
    url.searchParams.set("address", "0x0000000000000000000000000000000000000000");
    url.searchParams.set("chain", "8453");

    await guardedFetch(
      url,
      {
        headers: { "api-key": ZORA_API_KEY ?? "", Accept: "application/json" },
      },
      {
        hostKey: ZORA_HOST_KEY,
        concurrency: ZORA_CONCURRENCY,
        timeoutMs: Math.min(ZORA_TIMEOUT_MS, 5000),
        maxRetries: 0,
      },
    );

    if (!zoraApiHealthy) {
      const downtime = Math.floor((now - zoraApiLastHealthyAt) / 1000);
      console.log(`[sniper] 🟢 Zora API recovered after ${downtime}s downtime`);
    }
    zoraApiHealthy = true;
    zoraApiLastHealthyAt = now;
    return true;
  } catch (error) {
    if (zoraApiHealthy) {
      console.warn("[sniper] 🔴 Zora API health check FAILED:", error instanceof Error ? error.message : error);
    }
    zoraApiHealthy = false;
    return false;
  }
}

const createConcurrencyLimiter = (concurrency: number) => {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    activeCount -= 1;
    const resolve = queue.shift();
    if (resolve) resolve();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (activeCount >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    activeCount += 1;
    try {
      return await fn();
    } finally {
      next();
    }
  };
};

const runSlowValidationTask = createConcurrencyLimiter(
  SNIPER_SLOW_VALIDATION_CONCURRENCY,
);
const slowValidationInFlight = new Set<string>();

const scheduleSlowValidation = (token: TokenInfo, detectedAt: number) => {
  if (!SNIPER_ENABLE_SLOW_FALLBACK) return;
  const tokenKey = token.address.toLowerCase();
  if (slowValidationInFlight.has(tokenKey)) return;
  slowValidationInFlight.add(tokenKey);

  void runSlowValidationTask(async () => {
    try {
      const validation = await validateTokenWithRetry(token, 3);
      const totalTime = Date.now() - detectedAt;

      if (!validation.passes || !validation.creatorInfo) {
        console.log(
          `[sniper] Slow validation rejected: ${validation.reasons.join(", ") || "unknown"} (${totalTime}ms)`,
        );
        return;
      }

      const twitterFollowers = validation.creatorInfo.twitterFollowers ?? 0;
      if (twitterFollowers >= MIN_TWITTER_FOLLOWERS) {
        console.log(
          `[sniper] 🚀 BIG ACCOUNT (${twitterFollowers.toLocaleString()} Twitter) - Sending create alert (slow path)`,
        );
        if (SNIPER_ALERT_ON_CREATE) {
          await sendCreateAlert(token, validation.creatorInfo);
        }
        return;
      }

      console.log(`[sniper] ✅ Slow validation passed (${totalTime}ms total)`);
      if (SNIPER_ALERT_ON_CREATE) {
        await sendCreateAlert(token, validation.creatorInfo);
      }
      if (shouldWatchLiquidity()) {
        addToWatchlist(token, validation.creatorInfo);
      }
    } catch (error) {
      console.error(
        "[sniper] Slow validation error:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      slowValidationInFlight.delete(tokenKey);
    }
  });
};

const compareLogsByOrder = (a: any, b: any) => {
  const aBlock = (a?.blockNumber ?? 0n) as bigint;
  const bBlock = (b?.blockNumber ?? 0n) as bigint;
  if (aBlock === bBlock) {
    const aIndexRaw = a?.logIndex ?? a?.index ?? 0;
    const bIndexRaw = b?.logIndex ?? b?.index ?? 0;
    const aIndex = BigInt(aIndexRaw);
    const bIndex = BigInt(bIndexRaw);
    if (aIndex === bIndex) return 0;
    return aIndex < bIndex ? -1 : 1;
  }
  return aBlock < bBlock ? -1 : 1;
};

const backfillRecentEvents = async (
  client: any,
  runEventTask: ReturnType<typeof createConcurrencyLimiter>,
) => {
  if (!SNIPER_ENABLE_BACKFILL) {
    return;
  }

  if (sniperLastSeenBlock === null) {
    return;
  }

  let currentBlock: bigint;
  try {
    currentBlock = await client.getBlockNumber();
  } catch (error) {
    console.warn(
      "[sniper] Backfill skipped (could not get current block):",
      error instanceof Error ? error.message : error,
    );
    return;
  }

  const cursor = sniperLastSeenBlock;
  const fromBlock = cursor > SNIPER_BACKFILL_BLOCKS ? cursor - SNIPER_BACKFILL_BLOCKS : 0n;
  const toBlock = currentBlock;

  if (fromBlock >= toBlock) {
    return;
  }

  console.log(
    `[sniper] 🔎 Backfill: blocks ${fromBlock}..${toBlock} (cursor=${cursor}, maxLogs=${SNIPER_BACKFILL_MAX_LOGS})`,
  );

  const results = await Promise.allSettled([
    client.getLogs({
      address: CLANKER_FACTORY as `0x${string}`,
      event: CLANKER_TOKEN_CREATED,
      fromBlock,
      toBlock,
    }),
    client.getLogs({
      address: ZORA_FACTORY as `0x${string}`,
      event: ZORA_COIN_CREATED,
      fromBlock,
      toBlock,
    }),
    client.getLogs({
      address: ZORA_FACTORY as `0x${string}`,
      event: ZORA_CREATOR_COIN_CREATED,
      fromBlock,
      toBlock,
    }),
    client.getLogs({
      address: ZORA_FACTORY as `0x${string}`,
      event: ZORA_CREATOR_COIN_CREATED_V2,
      fromBlock,
      toBlock,
    }),
    client.getLogs({
      address: ZORA_FACTORY as `0x${string}`,
      event: ZORA_COIN_CREATED_V4,
      fromBlock,
      toBlock,
    }),
  ]);

  const logs: Log[] = [];
  const labels = [
    "clanker:TokenCreated",
    "zora:CoinCreated(legacy)",
    "zora:CreatorCoinCreated(v1)",
    "zora:CreatorCoinCreated(v2)",
    "zora:CoinCreatedV4(vip)",
  ];

  results.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      logs.push(...(result.value as Log[]));
      return;
    }
    console.warn(
      `[sniper] Backfill getLogs failed (${labels[idx] ?? "unknown"}):`,
      result.reason instanceof Error ? result.reason.message : result.reason,
    );
  });

  if (logs.length === 0) {
    console.log("[sniper] 🔎 Backfill: no logs found");
    return;
  }

  logs.sort(compareLogsByOrder);

  const toProcess =
    SNIPER_BACKFILL_MAX_LOGS > 0 && logs.length > SNIPER_BACKFILL_MAX_LOGS
      ? logs.slice(-SNIPER_BACKFILL_MAX_LOGS)
      : logs;

  console.log(
    `[sniper] 🔎 Backfill: collected ${logs.length} logs, scheduling ${toProcess.length}`,
  );

  for (const log of toProcess) {
    const eventId = getEventId(log);
    if (processedEventIds.has(eventId)) {
      continue;
    }

    processedEventIds.set(eventId, true);
    markSniperCursor(log.blockNumber);

    void runEventTask(async () => {
      try {
        const address = String(log.address ?? "").toLowerCase();
        if (address === CLANKER_FACTORY.toLowerCase()) {
          await handleClankerEvent(log);
          return;
        }
        if (address === ZORA_FACTORY.toLowerCase()) {
          await handleZoraEvent(log);
          await handleZoraVIPEvent(log);
        }
      } catch (error) {
        processedEventIds.delete(eventId);
        console.error(
          "[sniper] Backfill handler error:",
          error instanceof Error ? error.message : error,
        );
      }
    });
  }
};

// Pending tokens watchlist - tokens waiting for liquidity
interface PendingToken {
  token: TokenInfo;
  creatorInfo: CreatorInfo;
  addedAt: number;
  lastChecked: number;
  checkCount: number;
}
const pendingTokens = new Map<string, PendingToken>();
let watchlistCheckInFlight = false;

// Spam protection - track creator activity
const creatorTokenCount = new Map<string, { count: number; firstSeen: number }>();
const MAX_TOKENS_PER_CREATOR = 2; // Max tokens per creator in time window
const CREATOR_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const spamCountedTokens = new LRUCache<string, true>(50_000, CREATOR_WINDOW_MS);

// Twitter API
const TWITTER_API_BASE = (process.env.TWITTER_API_BASE ?? "https://api.twitterapi.io").replace(/\/$/, "");
const TWITTER_API_KEY = process.env.TWITTER_API_KEY;
const TWITTER_API_HOST = (() => {
  try {
    return new URL(TWITTER_API_BASE).host;
  } catch {
    return "twitter-api";
  }
})();
const TWITTER_CONCURRENCY = Number(process.env.TWITTER_CONCURRENCY ?? 4);
const TWITTER_TIMEOUT_MS = Number(process.env.TWITTER_TIMEOUT_MS ?? 10_000);
const SNIPER_TWITTER_FOLLOWERS_CACHE_TTL_MS = Number(
  process.env.SNIPER_TWITTER_FOLLOWERS_CACHE_TTL_MS ?? 10 * 60 * 1000,
);
const SNIPER_TWITTER_NOT_FOUND_CACHE_TTL_MS = Number(
  process.env.SNIPER_TWITTER_NOT_FOUND_CACHE_TTL_MS ?? 60 * 1000,
);
const twitterFollowersCache = new LRUCache<string, number | null>(
  20_000,
  SNIPER_TWITTER_FOLLOWERS_CACHE_TTL_MS,
);
const twitterFollowersInFlight = new Map<string, Promise<number | null>>();

// ============= EVENT SIGNATURES =============

// Clanker V4 uses Uniswap V3 pool creation pattern
const CLANKER_TOKEN_CREATED = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 supply)"
);

// Zora CoinCreated event - NOTE: coin is NOT indexed, it's in the data portion
// There are multiple variants: CoinCreated (legacy), CoinCreatedV4 (content coins), CreatorCoinCreated
const ZORA_COIN_CREATED = parseAbiItem(
  "event CoinCreated(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, address pool, string version)"
);

// CoinCreatedV4 for newer content coins - CORRECT signature with PoolKey tuple
// Hash: 0x2de436107c2096e039c98bbcc3c5a2560583738ce15c234557eecb4d3221aa81
const ZORA_COIN_CREATED_V4 = parseAbiItem(
  "event CoinCreatedV4(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, (address currency, address token0, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 poolId, string version)"
);

// CreatorCoinCreated for creator coins (OLD version without PoolKey tuple)
// Hash: 0x1a9651fe6627d3f75cdfa9998a36b8ca8bcaa1d4f9173e85c4b467384811257c
const ZORA_CREATOR_COIN_CREATED = parseAbiItem(
  "event CreatorCoinCreated(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, bytes32 poolKeyHash, string version)"
);
const CREATOR_COIN_TOPIC = "0x1a9651fe6627d3f75cdfa9998a36b8ca8bcaa1d4f9173e85c4b467384811257c";

// CreatorCoinCreated V2 (NEW version with PoolKey tuple) - Zora updated their contract
// Hash: 0x74b670d628e152daa36ca95dda7cb0002d6ea7a37b55afe4593db7abd1515781
const ZORA_CREATOR_COIN_CREATED_V2 = parseAbiItem(
  "event CreatorCoinCreated(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, (address currency, address token0, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 poolKeyHash, string version)"
);
const CREATOR_COIN_V2_TOPIC = "0x74b670d628e152daa36ca95dda7cb0002d6ea7a37b55afe4593db7abd1515781";

// CoinCreatedV4 topic hash - for VIP content/post coins
const COIN_CREATED_V4_TOPIC = "0x2de436107c2096e039c98bbcc3c5a2560583738ce15c234557eecb4d3221aa81";

// Legacy CoinCreated topic hash - for old Uniswap V3 style coins
// Hash: keccak256("CoinCreated(address,address,address,address,string,string,string,address,address,string)")
const COIN_CREATED_LEGACY_TOPIC = "0xe80ed94c33183ba307727bf230f18d40178975f51b301a8415b90f4c9f549b7f";

// VIP Address -> Username mapping for better logging
const VIP_ADDRESS_MAP = new Map<string, string>([
  ["0x9652721d02b9db43f4311102820158abb4ecc95b", "@base"],
  ["0x3092dd07eb967c8f155c958a12dd5c75de650921", "@base"],
  ["0x19ff7ea0badffa183f03533c3884f9ca03145aad", "@base"],
  ["0x17cd072cbd45031efc21da538c783e0ed3b25dcc", "@jacob"],
  ["0x4e1749017f9d36c2c8b96a5d662118c42dbdc1a5", "@jacob"],
  ["0x3a5df03dd1a001d7055284c2c2c147cbbc78d142", "@jacob"],
  ["0xf9fcd1fa7a5a3f2cf6fe3a33e1262b74c04feeda", "@zora"],
  ["0x7305de32957602344486a1016ecc4314da23d46b", "@zora"],
  ["0x70211a4c59fb9340bdb646a567f78d425f62da3c", "@zora"],
]);

// Also listen to standard Uniswap V3 PoolCreated in case factories use it
const POOL_CREATED = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
);

// ============= TYPES =============

interface CreatorInfo {
  fid?: number;
  username?: string;
  neynarScore?: number;
  twitterHandle?: string;
  twitterFollowers?: number;
  farcasterFollowers?: number;
  platform: "clanker" | "zora" | "unknown";
}

interface TokenInfo {
  address: string;
  name?: string;
  symbol?: string;
  creator?: string;
  poolAddress?: string;
  txHash: string;
  blockNumber: bigint;
  timestamp: number;
  platform: "clanker" | "zora";
}

// Creator lookup result with error distinction
type CreatorLookupResult =
  | { status: "success"; data: CreatorInfo }
  | { status: "not_found" }
  | { status: "api_error_503" }
  | { status: "api_error"; error: string };

// ============= NEYNAR LOOKUP =============

interface NeynarUserData {
  score: number;
  followers: number;
  fid: number;
  username?: string;
  twitterHandle?: string;
}

const neynarUserByAddressCache = new LRUCache<string, NeynarUserData | null>(
  20_000,
  SNIPER_NEYNAR_ADDRESS_CACHE_TTL_MS,
);
const neynarUserByAddressInFlight = new Map<
  string,
  Promise<NeynarUserData | null>
>();

const neynarUserByUsernameCache = new LRUCache<string, NeynarUserData | null>(
  20_000,
  SNIPER_NEYNAR_ADDRESS_CACHE_TTL_MS,
);
const neynarUserByUsernameInFlight = new Map<
  string,
  Promise<NeynarUserData | null>
>();

async function getNeynarScore(fid: number): Promise<{ score: number; followers: number } | null> {
  if (!NEYNAR_API_KEY) return null;

  try {
    const response = await guardedFetch(
      `${NEYNAR_API_URL}?fids=${fid}`,
      { headers: { "x-api-key": NEYNAR_API_KEY, Accept: "application/json" } },
      {
        hostKey: NEYNAR_API_HOST,
        concurrency: NEYNAR_CONCURRENCY,
        timeoutMs: NEYNAR_TIMEOUT_MS,
        maxRetries: 3,
        initialDelayMs: 500,
        shouldRetry: shouldRetryHttp,
      },
    );

    if (!response.ok) return null;

    const data = await response.json() as { users?: Array<{ experimental?: { neynar_user_score?: number }; score?: number; follower_count?: number }> };
    const user = data.users?.[0];
    if (!user) return null;

    return {
      score: user.score ?? user.experimental?.neynar_user_score ?? 0,
      followers: user.follower_count ?? 0,
    };
  } catch (error) {
    console.error("[sniper] Neynar lookup failed:", error);
    return null;
  }
}

// Lookup Farcaster user by username (for Zora tokens)
async function getNeynarUserByUsername(username: string): Promise<NeynarUserData | null> {
  if (!NEYNAR_API_KEY) return null;

  const key = username.replace(/^@/, "").trim().toLowerCase();
  if (!key) return null;

  const cached = neynarUserByUsernameCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const inFlight = neynarUserByUsernameInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    try {
      const response = await guardedFetch(
        `https://api.neynar.com/v2/farcaster/user/by_username?username=${encodeURIComponent(key)}`,
        { headers: { "x-api-key": NEYNAR_API_KEY, Accept: "application/json" } },
        {
          hostKey: NEYNAR_API_HOST,
          concurrency: NEYNAR_CONCURRENCY,
          timeoutMs: NEYNAR_TIMEOUT_MS,
          maxRetries: 3,
          initialDelayMs: 500,
          shouldRetry: shouldRetryHttp,
        },
      );

      if (response.status === 404) {
        neynarUserByUsernameCache.set(
          key,
          null,
          SNIPER_NEYNAR_NOT_FOUND_CACHE_TTL_MS,
        );
        return null;
      }

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as {
        user?: {
          fid?: number;
          username?: string;
          follower_count?: number;
          score?: number;
          experimental?: { neynar_user_score?: number };
          verified_accounts?: Array<{ platform?: string; username?: string }>;
        };
      };

      const user = data.user;
      if (!user || !user.fid) return null;

      // Extract Twitter handle from verified_accounts - validate with parseTwitterHandle
      const twitterAccount = user.verified_accounts?.find(
        (acc) =>
          acc.platform?.toLowerCase() === "x" ||
          acc.platform?.toLowerCase() === "twitter",
      );
      // Validate the handle - parseTwitterHandle handles URL and direct handle formats
      const validatedHandle = twitterAccount?.username
        ? parseTwitterHandle(twitterAccount.username)
        : null;

      const result: NeynarUserData = {
        fid: user.fid,
        username: user.username,
        score: user.score ?? user.experimental?.neynar_user_score ?? 0,
        followers: user.follower_count ?? 0,
        twitterHandle: validatedHandle ?? undefined,
      };

      neynarUserByUsernameCache.set(key, result);
      return result;
    } catch (error) {
      console.error(
        "[sniper] Neynar username lookup failed:",
        error instanceof Error ? error.message : error,
      );
      return null;
    } finally {
      neynarUserByUsernameInFlight.delete(key);
    }
  })();

  neynarUserByUsernameInFlight.set(key, task);
  return task;
}

// Lookup Farcaster user by wallet address (fast-path + fallback when Zora API fails)
async function getNeynarUserByAddress(
  address: string,
  mode: "fast" | "slow" = "slow",
): Promise<NeynarUserData | null> {
  if (!NEYNAR_API_KEY) return null;

  const addressLower = address.toLowerCase();
  const cached = neynarUserByAddressCache.get(addressLower);
  if (cached !== undefined) {
    return cached;
  }

  const inFlight = neynarUserByAddressInFlight.get(addressLower);
  if (inFlight) {
    if (mode === "fast" && SNIPER_FAST_TIMEOUT_MS > 0) {
      return Promise.race([
        inFlight,
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), SNIPER_FAST_TIMEOUT_MS),
        ),
      ]);
    }
    return inFlight;
  }

  const task = (async () => {
    try {
      const response = await guardedFetch(
        `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${addressLower}`,
        { headers: { api_key: NEYNAR_API_KEY, Accept: "application/json" } },
        {
          hostKey: NEYNAR_API_HOST,
          concurrency: NEYNAR_CONCURRENCY,
          timeoutMs: NEYNAR_TIMEOUT_MS,
          maxRetries: 2,
          initialDelayMs: 250,
          shouldRetry: shouldRetryHttp,
        },
      );

      if (response.status === 404) {
        neynarUserByAddressCache.set(
          addressLower,
          null,
          SNIPER_NEYNAR_NOT_FOUND_CACHE_TTL_MS,
        );
        return null;
      }

      if (!response.ok) {
        console.warn(`[sniper] Neynar address lookup HTTP ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        [address: string]: Array<{
          fid?: number;
          username?: string;
          follower_count?: number;
          score?: number;
          experimental?: { neynar_user_score?: number };
          verified_accounts?: Array<{ platform?: string; username?: string }>;
        }>;
      };

      // Get users for this address
      const users = data[addressLower];
      if (!users || users.length === 0) return null;

      // Take the first (primary) user
      const user = users[0];
      if (!user || !user.fid) return null;

      // Extract Twitter handle
      const twitterAccount = user.verified_accounts?.find(
        (acc) =>
          acc.platform?.toLowerCase() === "x" ||
          acc.platform?.toLowerCase() === "twitter",
      );
      const validatedHandle = twitterAccount?.username
        ? parseTwitterHandle(twitterAccount.username)
        : null;

      const result: NeynarUserData = {
        fid: user.fid,
        username: user.username,
        score: user.score ?? user.experimental?.neynar_user_score ?? 0,
        followers: user.follower_count ?? 0,
        twitterHandle: validatedHandle ?? undefined,
      };

      neynarUserByAddressCache.set(addressLower, result);
      return result;
    } catch (error) {
      console.error(
        "[sniper] Neynar address lookup failed:",
        error instanceof Error ? error.message : error,
      );
      return null;
    } finally {
      neynarUserByAddressInFlight.delete(addressLower);
    }
  })();

  neynarUserByAddressInFlight.set(addressLower, task);

  if (mode === "fast" && SNIPER_FAST_TIMEOUT_MS > 0) {
    return Promise.race([
      task,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), SNIPER_FAST_TIMEOUT_MS),
      ),
    ]);
  }

  return task;
}

// ============= TWITTER LOOKUP =============

async function getTwitterFollowers(
  handle: string,
  mode: "fast" | "slow" = "slow",
): Promise<number | null> {
  if (!TWITTER_API_KEY) {
    console.warn("[sniper] TWITTER_API_KEY not configured");
    return null;
  }

  const key = handle.replace(/^@/, "").trim().toLowerCase();
  if (!key) return null;

  const cached = twitterFollowersCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const inFlight = twitterFollowersInFlight.get(key);
  if (inFlight) {
    if (mode === "fast" && SNIPER_FAST_TIMEOUT_MS > 0) {
      return Promise.race([
        inFlight,
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), SNIPER_FAST_TIMEOUT_MS),
        ),
      ]);
    }
    return inFlight;
  }

  const task = (async () => {
    try {
      const url = new URL("/twitter/user/info", TWITTER_API_BASE);
      url.searchParams.set("userName", key);

      const response = await guardedFetch(
        url,
        {
          headers: { "x-api-key": TWITTER_API_KEY, Accept: "application/json" },
        },
        {
          hostKey: TWITTER_API_HOST,
          concurrency: TWITTER_CONCURRENCY,
          timeoutMs: TWITTER_TIMEOUT_MS,
          maxRetries: 2,
          initialDelayMs: 250,
          shouldRetry: shouldRetryHttp,
        },
      );

      if (response.status === 404) {
        twitterFollowersCache.set(
          key,
          null,
          SNIPER_TWITTER_NOT_FOUND_CACHE_TTL_MS,
        );
        return null;
      }

      if (!response.ok) {
        console.warn(`[sniper] Twitter API error: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        data?: { followers?: number; followersCount?: number };
      };
      const followers = data?.data?.followers ?? data?.data?.followersCount;

      if (typeof followers === "number" && Number.isFinite(followers)) {
        twitterFollowersCache.set(key, followers);
        return followers;
      }

      return null;
    } catch (error) {
      console.error(
        "[sniper] Twitter lookup failed:",
        error instanceof Error ? error.message : error,
      );
      return null;
    } finally {
      twitterFollowersInFlight.delete(key);
    }
  })();

  twitterFollowersInFlight.set(key, task);

  if (mode === "fast" && SNIPER_FAST_TIMEOUT_MS > 0) {
    return Promise.race([
      task,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), SNIPER_FAST_TIMEOUT_MS),
      ),
    ]);
  }

  return task;
}

function parseTwitterHandle(url?: string | null): string | null {
  if (!url) return null;

  // Direct handle (e.g., @username or username)
  if (!url.includes("/")) {
    const handle = url.replace(/^@/, "").trim().toLowerCase();
    return /^[a-z0-9_]+$/i.test(handle) ? handle : null;
  }

  // URL parsing
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("twitter.com") && !parsed.hostname.includes("x.com")) {
      return null;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    const firstSegment = segments[0];
    if (!firstSegment || firstSegment === "i") return null; // Skip /i/communities etc
    const handle = firstSegment.toLowerCase();
    return /^[a-z0-9_]+$/i.test(handle) ? handle : null;
  } catch {
    return null;
  }
}

// ============= CLANKER CREATOR LOOKUP =============

interface ClankerTokenData {
  requestor_fid?: number;
  social_context?: { id?: string; interface?: string };
  metadata?: {
    socialMediaUrls?: Array<{ platform?: string; url?: string }>;
  };
  description?: string;
}

// Known platform FIDs that should be filtered out (they're bots, not real creators)
const PLATFORM_FIDS = new Set([
  886870, // Bankr - https://bankr.bot/
]);

async function getClankerCreator(tokenAddress: string): Promise<CreatorInfo | null> {
  try {
    const addrLower = tokenAddress.toLowerCase();

    // Search by contract address
    const response = await guardedFetch(
      `${CLANKER_API_URL}?contractAddress=${addrLower}`,
      { headers: { Accept: "application/json" } },
      {
        hostKey: CLANKER_API_HOST,
        concurrency: CLANKER_CONCURRENCY,
        timeoutMs: CLANKER_TIMEOUT_MS,
        maxRetries: 2,
        initialDelayMs: 500,
        shouldRetry: shouldRetryHttp,
      },
    );

    if (!response.ok) return null;

    const data = await response.json() as { data?: ClankerTokenData[]; tokens?: ClankerTokenData[] };
    const token = data.data?.[0] || data.tokens?.[0];
    if (!token) return null;

    // Debug: log raw Clanker API response
    const interfaceName = token.social_context?.interface?.toLowerCase();
    const rawFid = token.requestor_fid || token.social_context?.id;
    console.log(`[sniper] Clanker API: interface=${interfaceName || 'N/A'}, fid=${rawFid || 'N/A'}, description=${token.description?.slice(0, 50) || 'N/A'}`);

    // Check if this is a Bankr or other platform deployment
    if (interfaceName === "bankr") {
      console.log(`[sniper] ❌ Skipping Bankr deployment - can't verify real creator`);
      return null;
    }

    // Also check description for Bankr signature
    if (token.description?.toLowerCase().includes("bankr")) {
      console.log(`[sniper] ❌ Skipping Bankr deployment (detected in description)`);
      return null;
    }

    // Safe FID conversion - avoid NaN from invalid strings (rawFid already declared above)
    const fid = rawFid !== undefined && rawFid !== null
      ? (Number.isFinite(Number(rawFid)) ? Number(rawFid) : undefined)
      : undefined;

    // Also check if the FID belongs to a known platform
    if (fid !== undefined && PLATFORM_FIDS.has(fid)) {
      console.log(`[sniper] Skipping platform FID ${fid} - not a real creator`);
      return null;
    }

    // Parallel lookups: Neynar + Twitter
    const [neynarData, twitterData] = await Promise.all([
      fid !== undefined ? getNeynarScore(fid) : Promise.resolve(null),
      (async () => {
        // Extract Twitter handle from metadata
        const socials = token.metadata?.socialMediaUrls ?? [];
        const twitterUrl = socials.find(s => s.platform?.toLowerCase() === "twitter")?.url;
        const handle = parseTwitterHandle(twitterUrl);
        if (!handle) return null;
        const followers = await getTwitterFollowers(handle);
        return { handle, followers };
      })(),
    ]);

    return {
      fid,
      neynarScore: neynarData?.score,
      farcasterFollowers: neynarData?.followers,
      twitterHandle: twitterData?.handle,
      twitterFollowers: twitterData?.followers ?? undefined,
      platform: "clanker",
    };
  } catch (error) {
    console.error("[sniper] Clanker creator lookup failed:", error);
    return null;
  }
}

// ============= ZORA CREATOR LOOKUP =============

type ZoraCreatorProfile = {
  handle?: string | null;
  socialAccounts?: {
    farcaster?: {
      id?: number | string | null;
      fid?: number | string | null;
      username?: string | null;
      followerCount?: number | null;
    } | null;
    twitter?: {
      username?: string | null;
      displayName?: string | null;
      followerCount?: number | null;
    } | null;
  } | null;
};

type ZoraCoinResponse = {
  data?: {
    zora20Token?: {
      name?: string;
      symbol?: string;
      creatorProfile?: ZoraCreatorProfile;
    };
  };
  // Direct response format (without data wrapper)
  zora20Token?: {
    name?: string;
    symbol?: string;
    creatorProfile?: ZoraCreatorProfile;
  };
};

type ZoraCoinResult =
  | { status: "success"; data: ZoraCoinResponse }
  | { status: "not_found" }
  | { status: "api_error"; error: string; is503?: boolean };

async function fetchZoraCoin(tokenAddress: string): Promise<ZoraCoinResult> {
  if (!ZORA_API_KEY) {
    console.log("[sniper] ZORA_API_KEY not configured");
    return { status: "api_error", error: "ZORA_API_KEY not configured" };
  }
  const bases = [ZORA_API_BASE, ZORA_API_BASE_FALLBACK].filter(Boolean);
  let lastError: string | undefined;
  let got404Count = 0;
  let got503 = false;

  for (const base of bases) {
    try {
      const url = new URL("/coin", base);
      url.searchParams.set("address", tokenAddress);
      url.searchParams.set("chain", "8453");
      const res = await guardedFetch(
        url,
        {
          headers: { "api-key": ZORA_API_KEY, Accept: "application/json" },
        },
        {
          hostKey: ZORA_HOST_KEY,
          concurrency: ZORA_CONCURRENCY,
          timeoutMs: ZORA_TIMEOUT_MS,
          maxRetries: 2,
          initialDelayMs: 500,
          shouldRetry: shouldRetryHttp,
        },
      );

      if (res.status === 404) {
        console.log(`[sniper] Zora API 404 for ${tokenAddress} on ${base}`);
        got404Count++;
        continue;
      }
      if (!res.ok) {
        lastError = `Zora HTTP ${res.status}`;
        continue;
      }
      try {
        // API is healthy again
        zoraApiHealthy = true;
        return { status: "success", data: (await res.json()) as ZoraCoinResponse };
      } catch (error) {
        lastError = `Zora non-JSON response (${res.status})`;
        continue;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      if (/\\bHTTP 503\\b/.test(message)) {
        got503 = true;
        console.warn(`[sniper] ⚠️ Zora API 503 on ${base} - infrastructure issue`);
      }
      continue;
    }
  }

  // If we got 404 on all endpoints, token doesn't exist (yet) on Zora
  if (got404Count === bases.length) {
    return { status: "not_found" };
  }

  // Track API health for 503 errors
  if (got503) {
    zoraApiHealthy = false;
    console.warn("[sniper] 🔴 Zora API marked as unhealthy (503)");
  }

  // Otherwise it's an API error
  if (lastError) {
    console.warn("[sniper] Zora coin lookup failed:", lastError);
    return { status: "api_error", error: lastError, is503: got503 };
  }
  return { status: "not_found" };
}

async function getZoraCreator(tokenAddress: string): Promise<CreatorLookupResult> {
  const result = await fetchZoraCoin(tokenAddress);

  if (result.status === "not_found") {
    console.log(`[sniper] Zora API: token not found (404)`);
    return { status: "not_found" };
  }

  if (result.status === "api_error") {
    console.log(`[sniper] Zora API error: ${result.error}`);
    // Return specific status for 503 errors (infrastructure issues)
    if (result.is503) {
      return { status: "api_error_503" };
    }
    return { status: "api_error", error: result.error };
  }

  const coin = result.data;
  // Handle both response formats: {data:{zora20Token:...}} and {zora20Token:...}
  const tokenMeta = coin?.data?.zora20Token ?? coin?.zora20Token;

  if (!tokenMeta?.creatorProfile) {
    console.log(`[sniper] Zora API: no creatorProfile found`);
    return { status: "not_found" };
  }

  const profile = tokenMeta.creatorProfile;
  console.log(`[sniper] Zora profile - handle: ${profile.handle}, farcaster: ${profile.socialAccounts?.farcaster?.username ?? 'null'}, twitter: ${profile.socialAccounts?.twitter?.username ?? 'null'}`);
  const handle = profile.handle;
  const farcaster = profile.socialAccounts?.farcaster;
  const twitter = profile.socialAccounts?.twitter;

  let neynarData: NeynarUserData | null = null;
  let twitterHandle: string | undefined;
  let twitterFollowers: number | undefined;

  // 1. Check if creator has Farcaster account with username
  if (farcaster?.username) {
    neynarData = await getNeynarUserByUsername(farcaster.username);
    // Get Twitter handle from Neynar if available
    if (neynarData?.twitterHandle) {
      twitterHandle = neynarData.twitterHandle;
      const followers = await getTwitterFollowers(twitterHandle);
      if (followers !== null) {
        twitterFollowers = followers;
      }
    }
  }
  // 2. Try Zora handle as Farcaster username (some users have same handle)
  else if (handle) {
    neynarData = await getNeynarUserByUsername(handle);
    if (neynarData?.twitterHandle) {
      twitterHandle = neynarData.twitterHandle;
      const followers = await getTwitterFollowers(twitterHandle);
      if (followers !== null) {
        twitterFollowers = followers;
      }
    }
  }

  // 3. If no Farcaster data found, use Twitter from Zora API directly
  if (twitter?.username && twitterFollowers === undefined) {
    twitterHandle = twitter.username;
    // Zora API already provides follower count, but it might be stale
    // Try live lookup first, fall back to Zora's cached data
    const liveFollowers = await getTwitterFollowers(twitter.username);
    if (liveFollowers !== null) {
      twitterFollowers = liveFollowers;
    } else if (typeof twitter.followerCount === "number") {
      twitterFollowers = twitter.followerCount;
    }
  }

  const farcasterFollowers =
    neynarData?.followers ??
    (typeof farcaster?.followerCount === "number" ? farcaster.followerCount : undefined);

  return {
    status: "success",
    data: {
      fid: neynarData?.fid ?? undefined,
      username: farcaster?.username ?? handle ?? undefined,
      neynarScore: neynarData?.score,
      farcasterFollowers,
      twitterHandle,
      twitterFollowers,
      platform: "zora",
    },
  };
}

// ============= VALIDATION =============

interface ValidationResult {
  passes: boolean;
  reasons: string[];
  creatorInfo?: CreatorInfo;
}

const checkCreatorSpamAndRecord = (
  creatorInfo: CreatorInfo,
  tokenAddress: string,
): { passes: boolean; reason?: string } => {
  const tokenKey = tokenAddress.toLowerCase();
  if (spamCountedTokens.has(tokenKey)) {
    return { passes: true };
  }

  const creatorKey =
    creatorInfo.fid?.toString() || creatorInfo.twitterHandle || "unknown";
  if (creatorKey === "unknown") {
    return { passes: true };
  }

  const now = Date.now();
  const creatorData = creatorTokenCount.get(creatorKey);

  if (!creatorData || now - creatorData.firstSeen > CREATOR_WINDOW_MS) {
    creatorTokenCount.set(creatorKey, { count: 1, firstSeen: now });
    spamCountedTokens.set(tokenKey, true);
    return { passes: true };
  }

  if (creatorData.count >= MAX_TOKENS_PER_CREATOR) {
    console.log(
      `[sniper] ⚠️ Spam detected: ${creatorKey} has ${creatorData.count} tokens in 24h`,
    );
    return { passes: false, reason: `spam: ${creatorKey}` };
  }

  creatorData.count++;
  spamCountedTokens.set(tokenKey, true);
  return { passes: true };
};

const evaluateCreator = (creatorInfo: CreatorInfo): Omit<ValidationResult, "creatorInfo"> => {
  const reasons: string[] = [];

  // === STRICT VALIDATION ===
  const neynarScore = creatorInfo.neynarScore;
  const twitterFollowers = creatorInfo.twitterFollowers;
  const farcasterFollowers = creatorInfo.farcasterFollowers;

  const twitterBigAccount =
    twitterFollowers !== undefined && twitterFollowers >= MIN_TWITTER_FOLLOWERS;

  // 1. Neynar score check (optional gate; can be bypassed by a big Twitter account)
  const neynarPasses =
    !SNIPER_NEYNAR_GATE_ENABLED ||
    twitterBigAccount ||
    (neynarScore !== undefined && neynarScore >= SNIPER_MIN_NEYNAR_SCORE);

  // 2. Twitter minimum check (REQUIRED: if Twitter exists, must be >= 5K)
  const twitterMinimumPasses =
    twitterFollowers === undefined || twitterFollowers >= MIN_TWITTER_MINIMUM;

  // 3. Follower check (REQUIRED: Twitter >= 100K OR Farcaster >= 10K)
  const twitterPasses =
    twitterFollowers !== undefined && twitterFollowers >= MIN_TWITTER_FOLLOWERS;
  const farcasterPasses =
    farcasterFollowers !== undefined && farcasterFollowers >= MIN_FARCASTER_FOLLOWERS;
  const followerPasses = twitterPasses || farcasterPasses;

  // Log the checks
  console.log(
    `[sniper] Neynar: ${
      neynarScore !== undefined ? `${(neynarScore * 100).toFixed(0)}%` : "N/A"
    } (min: ${(SNIPER_MIN_NEYNAR_SCORE * 100).toFixed(0)}%) - ${
      neynarPasses ? "✓" : "✗"
    }${SNIPER_NEYNAR_GATE_ENABLED ? "" : " (gate off)"}`,
  );
  console.log(
    `[sniper] Twitter: ${
      twitterFollowers !== undefined ? twitterFollowers.toLocaleString() : "N/A"
    } (min: ${MIN_TWITTER_MINIMUM.toLocaleString()}) - ${
      twitterMinimumPasses ? "✓" : "✗"
    }`,
  );
  console.log(
    `[sniper] Farcaster: ${
      farcasterFollowers !== undefined ? farcasterFollowers.toLocaleString() : "N/A"
    } (min: ${MIN_FARCASTER_FOLLOWERS.toLocaleString()}) - ${
      farcasterPasses ? "✓" : "✗"
    }`,
  );
  if (creatorInfo.twitterHandle) {
    console.log(`[sniper] Twitter handle: @${creatorInfo.twitterHandle}`);
  }

  // ALL conditions must pass: Twitter >= 5K AND (Twitter >= 100K OR Farcaster >= 10K) AND not spam
  const passes = neynarPasses && twitterMinimumPasses && followerPasses;

  if (!passes) {
    if (SNIPER_NEYNAR_GATE_ENABLED && !neynarPasses && !twitterBigAccount) {
      if (neynarScore !== undefined) {
        reasons.push(`neynar_low: ${(neynarScore * 100).toFixed(0)}%`);
      } else {
        reasons.push("neynar_unavailable");
      }
    }

    if (!twitterMinimumPasses) {
      reasons.push(`twitter_below_5k: ${twitterFollowers?.toLocaleString() ?? 0}`);
    }

    if (!followerPasses) {
      const twitterStr =
        twitterFollowers !== undefined ? `${(twitterFollowers / 1000).toFixed(0)}K` : "N/A";
      const farcasterStr =
        farcasterFollowers !== undefined ? `${(farcasterFollowers / 1000).toFixed(0)}K` : "N/A";
      reasons.push(`followers_low: tw=${twitterStr}, fc=${farcasterStr}`);
    }

  }

  return { passes, reasons };
};

async function validateTokenFast(token: TokenInfo): Promise<ValidationResult> {
  const startTime = Date.now();
  const reasons: string[] = [];

  if (!token.creator) {
    reasons.push("creator_missing");
    return { passes: false, reasons };
  }

  const addr = token.creator.toLowerCase();
  const neynarData = await getNeynarUserByAddress(addr, "fast");

  if (!neynarData) {
    reasons.push("creator_not_found_fast");
    return { passes: false, reasons };
  }

  if (PLATFORM_FIDS.has(neynarData.fid)) {
    reasons.push(`platform_fid: ${neynarData.fid}`);
    return { passes: false, reasons };
  }

  let twitterFollowers: number | undefined;
  if (neynarData.twitterHandle) {
    const followers = await getTwitterFollowers(neynarData.twitterHandle, "fast");
    if (followers !== null) {
      twitterFollowers = followers;
    }
  }

  const creatorInfo: CreatorInfo = {
    fid: neynarData.fid,
    username: neynarData.username,
    neynarScore: neynarData.score,
    farcasterFollowers: neynarData.followers,
    twitterHandle: neynarData.twitterHandle,
    twitterFollowers,
    platform: token.platform,
  };

  const evaluation = evaluateCreator(creatorInfo);
  if (evaluation.passes) {
    const spamCheck = checkCreatorSpamAndRecord(creatorInfo, token.address);
    if (!spamCheck.passes) {
      return {
        passes: false,
        reasons: [...evaluation.reasons, spamCheck.reason ?? "spam"],
        creatorInfo,
      };
    }
  }
  const elapsed = Date.now() - startTime;
  console.log(`[sniper] Fast validation took ${elapsed}ms - ${evaluation.passes ? "PASSED" : "REJECTED"}`);

  return { ...evaluation, creatorInfo };
}

async function validateToken(token: TokenInfo): Promise<ValidationResult> {
  const startTime = Date.now();

  console.log(`[sniper] Validating ${token.address} from ${token.platform}...`);

  // Parallel lookups
  let creatorInfo: CreatorInfo | null = null;
  const reasons: string[] = [];

  if (token.platform === "clanker") {
    creatorInfo = await getClankerCreator(token.address);
    if (!creatorInfo) {
      reasons.push("creator_not_found");
      return { passes: false, reasons };
    }
  } else if (token.platform === "zora") {
    const zoraResult = await getZoraCreator(token.address);

    // If Zora API fails, try Neynar wallet lookup as fallback
    if (zoraResult.status !== "success") {
      const is503 = zoraResult.status === "api_error_503";

      // Try fallback: lookup creator by wallet address via Neynar
      if (token.creator) {
        console.log(`[sniper] 🔄 Zora API ${is503 ? "503" : "failed"}, trying Neynar wallet fallback for ${token.creator.slice(0, 10)}...`);
        const neynarData = await getNeynarUserByAddress(token.creator);

        if (neynarData) {
          // Found user via wallet! Get their Twitter followers if they have a handle
          let twitterFollowers: number | undefined;
          if (neynarData.twitterHandle) {
            const followers = await getTwitterFollowers(neynarData.twitterHandle);
            if (followers !== null) {
              twitterFollowers = followers;
            }
          }

          creatorInfo = {
            fid: neynarData.fid,
            username: undefined, // We don't have Zora username
            neynarScore: neynarData.score,
            farcasterFollowers: neynarData.followers,
            twitterHandle: neynarData.twitterHandle,
            twitterFollowers,
            platform: "zora",
          };
          console.log(`[sniper] ✅ Neynar fallback success: @${neynarData.twitterHandle ?? "no-twitter"} (${twitterFollowers?.toLocaleString() ?? 0} followers)`);
        }
      }

      // If fallback also failed, return appropriate error
      if (!creatorInfo) {
        if (is503) {
          reasons.push("api_error_503");
        } else {
          reasons.push("creator_not_found");
        }
        return { passes: false, reasons };
      }
    } else {
      creatorInfo = zoraResult.data;
    }
  }

  if (!creatorInfo) {
    reasons.push("creator_not_found");
    return { passes: false, reasons };
  }

  const evaluation = evaluateCreator(creatorInfo);
  if (evaluation.passes) {
    const spamCheck = checkCreatorSpamAndRecord(creatorInfo, token.address);
    if (!spamCheck.passes) {
      evaluation.passes = false;
      evaluation.reasons.push(spamCheck.reason ?? "spam");
    }
  }
  const elapsed = Date.now() - startTime;
  console.log(
    `[sniper] Validation took ${elapsed}ms - ${
      evaluation.passes ? "PASSED" : "REJECTED"
    }`,
  );

  return { ...evaluation, creatorInfo };
}

async function validateTokenWithRetry(token: TokenInfo, maxRetries: number = 5): Promise<ValidationResult> {
  // Extended delays for API indexing + 503 recovery: 1s, 2s, 4s, 8s, 16s = ~31s total
  const delays = [1000, 2000, 4000, 8000, 16000];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await validateToken(token);

    // If we found the creator (even with partial data), return the result
    // Partial data is okay - it means API is indexed, just missing some social info
    if (!result.reasons.includes("creator_not_found") && !result.reasons.includes("api_error_503")) {
      return result;
    }

    // For 503 errors, use longer delays (API infrastructure issue)
    const is503 = result.reasons.includes("api_error_503");

    // If creator not found or 503 error and we have retries left, wait and retry
    if (attempt < maxRetries) {
      const baseDelay = delays[attempt] ?? delays[delays.length - 1] ?? 16000;
      // Double the delay for 503 errors (infrastructure issues take longer to resolve)
      const delay = is503 ? Math.min(baseDelay * 2, 30000) : baseDelay;
      const reason = is503 ? "API 503 error" : "Creator not indexed yet";
      console.log(`[sniper] ${reason}, retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted
  console.log(`[sniper] Creator lookup failed after ${maxRetries} retries (~31 seconds)`);
  return { passes: false, reasons: ["creator_not_found_after_retries"] };
}

// ============= LOGGING =============

const PASSED_TOKENS_LOG = path.join(process.cwd(), "passed_tokens.jsonl");

interface PassedTokenLog {
  timestamp: string;
  token: string;
  name?: string;
  symbol?: string;
  platform: "clanker" | "zora";
  txHash: string;
  blockNumber: string;
  creator: {
    fid?: number;
    username?: string;
    neynarScore?: number;
    neynarScorePercent?: string;
    farcasterFollowers?: number;
    twitterHandle?: string;
    twitterFollowers?: number;
  };
  followerType: "twitter_70k" | "farcaster_40k" | "both";
  dexscreenerUrl: string;
}

async function logPassedToken(
  token: TokenInfo,
  creatorInfo: CreatorInfo,
): Promise<void> {
  const twitterPasses = creatorInfo.twitterFollowers !== undefined && creatorInfo.twitterFollowers >= MIN_TWITTER_FOLLOWERS;
  const farcasterPasses = creatorInfo.farcasterFollowers !== undefined && creatorInfo.farcasterFollowers >= MIN_FARCASTER_FOLLOWERS;

  const logEntry: PassedTokenLog = {
    timestamp: new Date().toISOString(),
    token: token.address,
    name: token.name,
    symbol: token.symbol,
    platform: token.platform,
    txHash: token.txHash,
    blockNumber: token.blockNumber.toString(),
    creator: {
      fid: creatorInfo.fid,
      username: creatorInfo.username,
      neynarScore: creatorInfo.neynarScore,
      neynarScorePercent: creatorInfo.neynarScore !== undefined
        ? `${(creatorInfo.neynarScore * 100).toFixed(0)}%`
        : undefined,
      farcasterFollowers: creatorInfo.farcasterFollowers,
      twitterHandle: creatorInfo.twitterHandle,
      twitterFollowers: creatorInfo.twitterFollowers,
    },
    followerType: twitterPasses && farcasterPasses ? "both" : twitterPasses ? "twitter_70k" : "farcaster_40k",
    dexscreenerUrl: `https://dexscreener.com/base/${token.address}`,
  };

  try {
    await fs.promises.appendFile(
      PASSED_TOKENS_LOG,
      JSON.stringify(logEntry) + "\n",
      "utf8",
    );
    console.log(`[sniper] Logged to ${PASSED_TOKENS_LOG}`);
  } catch (error) {
    console.error("[sniper] Failed to log passed token:", error);
  }
}

// ============= ALERT =============

// Add token to watchlist instead of sending alert immediately
function addToWatchlist(token: TokenInfo, creatorInfo: CreatorInfo): void {
  const now = Date.now();

  // Check if already in watchlist
  if (pendingTokens.has(token.address.toLowerCase())) {
    console.log(`[sniper] Token ${token.address} already in watchlist, skipping`);
    return;
  }

  pendingTokens.set(token.address.toLowerCase(), {
    token,
    creatorInfo,
    addedAt: now,
    lastChecked: 0,
    checkCount: 0,
  });

  console.log(`[sniper] 📋 Added to watchlist: ${token.symbol || token.address} (watching for $${MIN_LIQUIDITY_USD.toLocaleString()} liquidity)`);
  console.log(`[sniper] 📋 Watchlist size: ${pendingTokens.size}`);
}

// Calculate token quality score based on creator metrics (0-8 scale)
function calculateCreatorScore(creatorInfo: CreatorInfo): number {
  let score = 0;

  // Twitter followers (max 3 points)
  if (creatorInfo.twitterFollowers) {
    if (creatorInfo.twitterFollowers >= 500000) score += 3;      // 500K+
    else if (creatorInfo.twitterFollowers >= 100000) score += 2; // 100K+
    else if (creatorInfo.twitterFollowers >= 50000) score += 1;  // 50K+
  }

  // Farcaster followers (max 2 points)
  if (creatorInfo.farcasterFollowers) {
    if (creatorInfo.farcasterFollowers >= 50000) score += 2;     // 50K+
    else if (creatorInfo.farcasterFollowers >= 10000) score += 1; // 10K+
  }

  // Neynar score (max 2 points)
  if (creatorInfo.neynarScore) {
    if (creatorInfo.neynarScore >= 0.95) score += 2;             // 95%+
    else if (creatorInfo.neynarScore >= 0.85) score += 1;        // 85%+
  }

  // Has both Twitter and Farcaster (1 point for multi-platform presence)
  if (creatorInfo.twitterFollowers && creatorInfo.farcasterFollowers) {
    score += 1;
  }

  return Math.min(score, 8); // Cap at 8
}

// Send alert when liquidity threshold is met
async function sendLiquidityAlert(
  token: TokenInfo,
  creatorInfo: CreatorInfo,
  liquidity: number,
  metrics?: { totalVolumeH24?: number; totalBuysH1?: number; totalSellsH1?: number; priceChangeH1?: number }
): Promise<void> {
  // Log in background (avoid blocking the alert path on disk I/O)
  void logPassedToken(token, creatorInfo);

  const score = calculateCreatorScore(creatorInfo);

  const alert: TokenAlert = {
    token: token.address,
    symbol: token.symbol,
    name: token.name,
    platform: token.platform,
    liquidity: liquidity,
    volume24h: metrics?.totalVolumeH24,
    buysH1: metrics?.totalBuysH1,
    sellsH1: metrics?.totalSellsH1,
    priceChange: metrics?.priceChangeH1,
    score,
    neynarScore: creatorInfo.neynarScore,
    twitterFollowers: creatorInfo.twitterFollowers,
    farcasterFollowers: creatorInfo.farcasterFollowers,
    poolAddress: token.poolAddress,
    creatorFid: creatorInfo.fid,
    dexscreenerUrl: `https://dexscreener.com/base/${token.address}`,
    twitterHandle: creatorInfo.twitterHandle,
    farcasterUsername: creatorInfo.username,
  };

  await sendTelegramAlert(alert);

  // Execute auto-buy if enabled
  const autoBuyStatus = isAutoBuyReady();
  if (autoBuyStatus.ready) {
    console.log(`[sniper] 🛒 Auto-buy triggered for ${token.symbol || token.address}`);

    const buyRequest: BuyRequest = {
      tokenAddress: token.address as `0x${string}`,
      symbol: token.symbol,
      name: token.name,
      platform: token.platform,
      poolAddress: token.poolAddress as `0x${string}` | undefined,
      liquidity,
      creatorInfo: {
        twitterFollowers: creatorInfo.twitterFollowers,
        farcasterFollowers: creatorInfo.farcasterFollowers,
        twitterHandle: creatorInfo.twitterHandle,
      },
    };

    // Execute buy in background (don't block alert flow)
    void executeBuy(buyRequest).then((result) => {
      if (result.success) {
        console.log(`[sniper] ✅ Auto-buy successful: ${result.txHash}`);
      } else if (result.skipped) {
        console.log(`[sniper] ⏭️ Auto-buy skipped: ${result.skipReason}`);
      } else {
        console.log(`[sniper] ❌ Auto-buy failed: ${result.error}`);
      }
    });
  }
}

async function sendCreateAlert(
  token: TokenInfo,
  creatorInfo: CreatorInfo,
): Promise<void> {
  const tokenKey = token.address.toLowerCase();
  if (createAlertedTokens.has(tokenKey)) {
    return;
  }
  createAlertedTokens.set(tokenKey, true);

  // Log in background (avoid blocking the alert path on disk I/O)
  void logPassedToken(token, creatorInfo);

  const score = calculateCreatorScore(creatorInfo);

  const alert: TokenAlert = {
    token: token.address,
    symbol: token.symbol,
    name: token.name,
    platform: token.platform,
    score,
    neynarScore: creatorInfo.neynarScore,
    twitterFollowers: creatorInfo.twitterFollowers,
    farcasterFollowers: creatorInfo.farcasterFollowers,
    poolAddress: token.poolAddress,
    creatorFid: creatorInfo.fid,
    dexscreenerUrl: `https://dexscreener.com/base/${token.address}`,
    twitterHandle: creatorInfo.twitterHandle,
    farcasterUsername: creatorInfo.username,
  };

  await sendTelegramAlert(alert);
}

// Check liquidity for all pending tokens
async function checkWatchlistLiquidity(): Promise<void> {
  const now = Date.now();
  const toRemove = new Set<string>();
  const toCheck: Array<[string, PendingToken]> = [];

  for (const [address, pending] of pendingTokens.entries()) {
    const age = now - pending.addedAt;

    // Remove if expired (1 hour)
    if (age > WATCHLIST_MAX_AGE_MS) {
      console.log(`[sniper] ⏰ Expired: ${pending.token.symbol || address} (no liquidity after 1h)`);
      toRemove.add(address);
      continue;
    }

    // Skip if checked recently
    if (now - pending.lastChecked < WATCHLIST_CHECK_INTERVAL_MS) {
      continue;
    }

    pending.lastChecked = now;
    pending.checkCount++;
    toCheck.push([address, pending]);
  }

  if (toCheck.length === 0) {
    for (const address of toRemove) {
      pendingTokens.delete(address);
    }
    return;
  }

  const runWithLimit = createConcurrencyLimiter(WATCHLIST_DEX_CONCURRENCY);

  await Promise.all(
    toCheck.map(([address, pending]) =>
      runWithLimit(async () => {
        const age = now - pending.addedAt;

        try {
          const pairs = await fetchPairsForToken(pending.token.address);

          if (pairs.length === 0) {
            // Not on DexScreener yet
            if (pending.checkCount % 6 === 0) { // Log every minute
              console.log(`[sniper] 👀 Watching: ${pending.token.symbol || address} (not on DexScreener yet, ${Math.floor(age / 60000)}m)`);
            }
            return;
          }

          const metrics = aggregateTokenMetrics(pending.token.address, pairs);
          const liquidity = metrics.totalLiquidityUsd;

          if (liquidity >= MIN_LIQUIDITY_USD) {
            // LIQUIDITY THRESHOLD MET - SEND ALERT!
            console.log(`[sniper] 🚀 LIQUIDITY HIT! ${pending.token.symbol || address}: $${liquidity.toLocaleString()}`);
            const tokenKey = pending.token.address.toLowerCase();
            const shouldSendLiquidity =
              SNIPER_ALERT_ON_LIQUIDITY &&
              (SNIPER_LIQUIDITY_ALERT_AFTER_CREATE ||
                !createAlertedTokens.has(tokenKey));

            if (shouldSendLiquidity) {
              // Pass metrics to alert for volume/buys/sells data
              await sendLiquidityAlert(pending.token, pending.creatorInfo, liquidity, {
                totalVolumeH24: metrics.totalVolumeH24,
                totalBuysH1: metrics.totalBuysH1,
                totalSellsH1: metrics.totalSellsH1,
                priceChangeH1: metrics.priceChangeH1,
              });
            } else {
              // Still log the hit for visibility, even if Telegram is skipped.
              const reason = !SNIPER_ALERT_ON_LIQUIDITY
                ? "SNIPER_ALERT_ON_LIQUIDITY disabled"
                : "already alerted on create";
              console.log(`[sniper] 📵 Liquidity alert skipped (${reason})`);
            }
            toRemove.add(address);
            return;
          }

          // Still watching
          if (pending.checkCount % 6 === 0) { // Log every minute
            console.log(`[sniper] 👀 Watching: ${pending.token.symbol || address} - $${liquidity.toLocaleString()} (need $${MIN_LIQUIDITY_USD.toLocaleString()}, ${Math.floor(age / 60000)}m)`);
          }
        } catch (error) {
          console.error(`[sniper] Error checking ${address}:`, error instanceof Error ? error.message : error);
        }
      }),
    ),
  );

  // Remove processed tokens
  for (const address of toRemove) {
    pendingTokens.delete(address);
  }
}

// Start watchlist monitoring loop
function startWatchlistLoop(): void {
  console.log(`[sniper] 👀 Starting watchlist monitor (check every ${WATCHLIST_CHECK_INTERVAL_MS / 1000}s, max ${WATCHLIST_MAX_AGE_MS / 60000}m)`);

  setInterval(() => {
    if (pendingTokens.size === 0) return;
    if (watchlistCheckInFlight) return;
    watchlistCheckInFlight = true;
    void checkWatchlistLiquidity()
      .catch((error) => {
        console.error(
          "[sniper] Watchlist check failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        watchlistCheckInFlight = false;
      });
  }, WATCHLIST_CHECK_INTERVAL_MS);
}

// ============= EVENT HANDLERS =============

async function handleClankerEvent(log: Log): Promise<void> {
  const logAny = log as any;
  const args = logAny.args ?? {};
  const eventName = logAny.eventName as string | undefined;

  // Ignore non-TokenCreated logs (e.g. PoolCreated) to keep validation fast and accurate.
  if (eventName && eventName !== "TokenCreated") {
    return;
  }
  if (typeof args.token !== "string" || typeof args.creator !== "string") {
    return;
  }

  const eventTime = Date.now();
  console.log(`\n[sniper] 🚨 CLANKER EVENT DETECTED at ${new Date().toISOString()}`);
  console.log(`[sniper] TX: ${log.transactionHash}`);
  console.log(`[sniper] Block: ${log.blockNumber}`);

  const topics = logAny.topics as string[] | undefined;

  // Helper to normalize address (handle 32-byte padded or regular 20-byte)
  const normalizeAddress = (addr: string | undefined | null): string | null => {
    if (!addr) return null;
    const hex = addr.toLowerCase().replace(/^0x/, "");
    if (hex.length < 40) return null;
    const normalized = hex.slice(-40);
    if (!/^[a-f0-9]{40}$/.test(normalized)) return null;
    return `0x${normalized}`;
  };

  const tokenAddress = normalizeAddress(args.token);
  const creatorAddress = normalizeAddress(args.creator);

  // Validate we got a proper token address
  if (!tokenAddress || tokenAddress === log.address) {
    console.log(`[sniper] ⚠️ Could not extract token address from event, skipping`);
    console.log(`[sniper] Args:`, JSON.stringify(args));
    console.log(`[sniper] Topics:`, topics);
    return;
  }

  // Early Bankr check - skip before any API calls
  if (tokenAddress.toLowerCase().endsWith("b07")) {
    console.log(`[sniper] ❌ Skipping Bankr deployment (address ends with b07): ${tokenAddress}`);
    return;
  }

  console.log(`[sniper] Token: ${tokenAddress}`);
  console.log(`[sniper] Creator: ${creatorAddress}`);
  if (args.name) console.log(`[sniper] Name: ${args.name}`);
  if (args.symbol) console.log(`[sniper] Symbol: ${args.symbol}`);

  const token: TokenInfo = {
    address: tokenAddress,
    name: args.name,
    symbol: args.symbol,
    creator: creatorAddress ?? undefined,
    txHash: log.transactionHash!,
    blockNumber: log.blockNumber!,
    timestamp: eventTime,
    platform: "clanker",
  };

  const fastValidation = await validateTokenFast(token);
  const fastTime = Date.now() - eventTime;

  if (fastValidation.passes && fastValidation.creatorInfo) {
    const twitterFollowers = fastValidation.creatorInfo.twitterFollowers ?? 0;

    if (twitterFollowers >= MIN_TWITTER_FOLLOWERS) {
      console.log(
        `[sniper] 🚀 BIG ACCOUNT (${twitterFollowers.toLocaleString()} Twitter) - Sending create alert! (${fastTime}ms)`,
      );
      if (SNIPER_ALERT_ON_CREATE) {
        await sendCreateAlert(token, fastValidation.creatorInfo);
      }
      return;
    }

    console.log(`[sniper] ✅ TOKEN PASSED FAST! (${fastTime}ms)`);
    if (SNIPER_ALERT_ON_CREATE) {
      await sendCreateAlert(token, fastValidation.creatorInfo);
    }
    if (shouldWatchLiquidity()) {
      addToWatchlist(token, fastValidation.creatorInfo);
    }
    return;
  }

  console.log(
    `[sniper] ⏳ Fast validation failed (${fastTime}ms): ${fastValidation.reasons.join(", ") || "unknown"}`,
  );
  scheduleSlowValidation(token, eventTime);
}

async function handleZoraEvent(log: Log): Promise<void> {
  const logAny = log as any;
  const topics = logAny.topics as string[] | undefined;

  // Filter: Process CreatorCoinCreated (V1 + V2) and legacy CoinCreated events
  // Skip CoinCreatedV4 (content/post coins) - those are handled by VIP handler
  const eventTopic = topics?.[0]?.toLowerCase();
  const isLegacyCoinCreated = eventTopic === COIN_CREATED_LEGACY_TOPIC.toLowerCase();
  const isOldCreatorCoin = eventTopic === CREATOR_COIN_TOPIC.toLowerCase();
  const isNewCreatorCoin = eventTopic === CREATOR_COIN_V2_TOPIC.toLowerCase();

  if (!isLegacyCoinCreated && !isOldCreatorCoin && !isNewCreatorCoin) {
    // Silently skip other events (like CoinCreatedV4 which goes to VIP handler)
    return;
  }

  const eventTime = Date.now();
  const eventVersion = isLegacyCoinCreated ? "Legacy (V3 pool)" : isNewCreatorCoin ? "V2 (with PoolKey)" : "V1";
  console.log(`\n[sniper] 🚨 ZORA COIN DETECTED [${eventVersion}] at ${new Date().toISOString()}`);
  console.log(`[sniper] TX: ${log.transactionHash}`);
  console.log(`[sniper] Block: ${log.blockNumber}`);

  // Decode event args
  // IMPORTANT: In Zora events, 'coin' is NOT indexed - it's in the decoded args, not topics
  // Topics contain: [0]=eventSignature, [1]=caller, [2]=payoutRecipient, [3]=platformReferrer
  const args = logAny.args ?? {};

  // Debug: log raw data
  console.log(`[sniper] Args keys:`, Object.keys(args));
  console.log(`[sniper] Args:`, JSON.stringify(args, (_, v) => typeof v === 'bigint' ? v.toString() : v));
  console.log(`[sniper] Topics count:`, topics?.length ?? 0);

  // Helper to normalize address (handle 32-byte padded or regular 20-byte)
  const normalizeAddress = (addr: string | undefined | null): string | null => {
    if (!addr) return null;
    const hex = addr.toLowerCase().replace(/^0x/, "");
    if (hex.length < 40) return null;
    const normalized = hex.slice(-40);
    if (!/^[a-f0-9]{40}$/.test(normalized)) return null;
    return `0x${normalized}`;
  };

  // 'coin' is NOT indexed - it comes from decoded args, not topics!
  // Topics: [0]=sig, [1]=caller (indexed), [2]=payoutRecipient (indexed), [3]=platformReferrer (indexed)
  const rawCoin = args.coin;
  const rawCaller = args.caller ?? topics?.[1]; // caller is indexed
  const rawPayoutRecipient = args.payoutRecipient ?? topics?.[2]; // payoutRecipient is indexed
  const coinAddress = normalizeAddress(rawCoin);
  const callerAddress = normalizeAddress(rawCaller);
  const payoutRecipientAddress = normalizeAddress(rawPayoutRecipient);

  // Extract additional info from decoded args
  const tokenName = args.name;
  const tokenSymbol = args.symbol;

  // Pool address extraction differs by event type:
  // - Legacy CoinCreated: has 'pool' field directly (Uniswap V3 style)
  // - CreatorCoinCreated V1: has 'poolKeyHash' (bytes32) - no direct pool address
  // - CreatorCoinCreated V2: has 'poolKey' tuple + 'poolKeyHash' - pool derived from poolKey
  // Note: poolKey.hooks is NOT the pool address - it's the Uniswap V4 hooks contract
  const poolKey = args.poolKey as { currency?: string; token0?: string; fee?: number; tickSpacing?: number; hooks?: string } | undefined;
  const poolKeyHash = args.poolKeyHash as string | undefined;
  // For legacy events, use args.pool directly. For V4 events, we don't have a direct pool address
  const poolAddress = args.pool ?? undefined; // Don't use poolKey.hooks - it's wrong!

  // Skip if we couldn't extract coin address
  if (!coinAddress) {
    console.log(`[sniper] ⚠️ Could not extract coin address from args`);
    console.log(`[sniper] This may mean the event ABI doesn't match`);
    console.log(`[sniper] Try checking the actual event signature on Basescan`);
    return;
  }

  // Skip if we somehow got the factory address
  if (coinAddress.toLowerCase() === log.address.toLowerCase()) {
    console.log(`[sniper] ⚠️ Got factory address instead of coin address, skipping`);
    return;
  }

  console.log(`[sniper] Coin: ${coinAddress}`);
  if (callerAddress) console.log(`[sniper] Caller: ${callerAddress}`);
  if (payoutRecipientAddress) console.log(`[sniper] Payout: ${payoutRecipientAddress}`);
  if (tokenName) console.log(`[sniper] Name: ${tokenName}`);
  if (tokenSymbol) console.log(`[sniper] Symbol: ${tokenSymbol}`);
  if (poolAddress) console.log(`[sniper] Pool: ${poolAddress}`);
  if (poolKeyHash) console.log(`[sniper] PoolKeyHash: ${poolKeyHash}`);
  if (poolKey) console.log(`[sniper] PoolKey:`, JSON.stringify(poolKey, (_, v) => typeof v === 'bigint' ? v.toString() : v));

  const creatorAddress = payoutRecipientAddress ?? callerAddress ?? undefined;

  const token: TokenInfo = {
    address: coinAddress,
    name: tokenName,
    symbol: tokenSymbol,
    txHash: log.transactionHash!,
    blockNumber: log.blockNumber!,
    timestamp: eventTime,
    platform: "zora",
    creator: creatorAddress,
    poolAddress: normalizeAddress(poolAddress) ?? undefined,
  };

  const fastValidation = await validateTokenFast(token);
  const fastTime = Date.now() - eventTime;

  if (fastValidation.passes && fastValidation.creatorInfo) {
    const twitterFollowers = fastValidation.creatorInfo.twitterFollowers ?? 0;

    if (twitterFollowers >= MIN_TWITTER_FOLLOWERS) {
      console.log(
        `[sniper] 🚀 BIG ACCOUNT (${twitterFollowers.toLocaleString()} Twitter) - Sending create alert! (${fastTime}ms)`,
      );
      if (SNIPER_ALERT_ON_CREATE) {
        await sendCreateAlert(token, fastValidation.creatorInfo);
      }
      return;
    }

    console.log(`[sniper] ✅ Zora token passed FAST! (${fastTime}ms)`);
    if (SNIPER_ALERT_ON_CREATE) {
      await sendCreateAlert(token, fastValidation.creatorInfo);
    }
    if (shouldWatchLiquidity()) {
      addToWatchlist(token, fastValidation.creatorInfo);
    }
    return;
  }

  console.log(
    `[sniper] ⏳ Fast validation failed (${fastTime}ms): ${fastValidation.reasons.join(", ") || "unknown"}`,
  );
  scheduleSlowValidation(token, eventTime);
}

/**
 * Handle VIP content coins (CoinCreatedV4)
 * Only process if caller is in VIP list (@base, @jacob, @zora)
 * These are trusted accounts - skip normal validation, go straight to watchlist
 */
async function handleZoraVIPEvent(log: Log): Promise<void> {
  const logAny = log as any;
  const topics = logAny.topics as string[] | undefined;
  const args = logAny.args ?? {};

  // Verify it's CoinCreatedV4
  const eventTopic = topics?.[0]?.toLowerCase();
  if (eventTopic !== COIN_CREATED_V4_TOPIC.toLowerCase()) {
    return;
  }

  // Helper to normalize address (handle 32-byte padded or regular 20-byte)
  const normalizeAddress = (addr: string | undefined | null): string | null => {
    if (!addr) return null;
    const hex = addr.toLowerCase().replace(/^0x/, '');
    const normalized = hex.length === 64 ? hex.slice(-40) : hex.slice(-40);
    return `0x${normalized}`;
  };

  // Get caller address - topics[1] is indexed caller
  const rawCaller = args.caller ?? topics?.[1];
  const rawPayoutRecipient = args.payoutRecipient ?? topics?.[2];
  const callerAddress = normalizeAddress(rawCaller);
  const payoutRecipientAddress = normalizeAddress(rawPayoutRecipient);

  if (!callerAddress && !payoutRecipientAddress) {
    return; // Can't determine caller
  }

  const vipAddress =
    payoutRecipientAddress && ZORA_VIP_ADDRESSES.has(payoutRecipientAddress.toLowerCase())
      ? payoutRecipientAddress
      : callerAddress && ZORA_VIP_ADDRESSES.has(callerAddress.toLowerCase())
        ? callerAddress
        : null;

  // Check if caller or payoutRecipient is in VIP list
  if (!vipAddress) {
    return; // Not a VIP, silently skip
  }

  const eventTime = Date.now();
  console.log(`\n[sniper] 🌟 VIP CONTENT COIN DETECTED at ${new Date().toISOString()}`);
  console.log(`[sniper] TX: ${log.transactionHash}`);
  console.log(`[sniper] Block: ${log.blockNumber}`);
  console.log(`[sniper] VIP Address: ${vipAddress}`);

  // Extract coin address and other info
  const rawCoin = args.coin;
  const coinAddress = normalizeAddress(rawCoin);
  const tokenName = args.name;
  const tokenSymbol = args.symbol;
  const poolAddress = args.pool ?? undefined;

  if (!coinAddress) {
    console.log(`[sniper] ⚠️ Could not extract coin address from VIP event`);
    return;
  }

  console.log(`[sniper] Coin: ${coinAddress}`);
  if (tokenName) console.log(`[sniper] Name: ${tokenName}`);
  if (tokenSymbol) console.log(`[sniper] Symbol: ${tokenSymbol}`);

  const token: TokenInfo = {
    address: coinAddress,
    name: tokenName,
    symbol: tokenSymbol,
    txHash: log.transactionHash!,
    blockNumber: log.blockNumber!,
    timestamp: eventTime,
    platform: "zora",
    creator: vipAddress,
    poolAddress: normalizeAddress(poolAddress) ?? undefined,
  };

  // VIPs don't need validation - create creator info with mapped username
  const vipUsername = VIP_ADDRESS_MAP.get(vipAddress.toLowerCase()) ?? "VIP";
  const vipCreatorInfo: CreatorInfo = {
    username: vipUsername,
    platform: "zora",
    neynarScore: 1.0, // Perfect score for VIPs
  };

  console.log(`[sniper] ✅ VIP token from ${vipUsername} - Adding to watchlist immediately!`);
  if (SNIPER_ALERT_ON_CREATE) {
    await sendCreateAlert(token, vipCreatorInfo);
  }
  if (shouldWatchLiquidity()) {
    addToWatchlist(token, vipCreatorInfo);
  }
}

// ============= MAIN =============

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("[sniper] 🎯 SNIPER BOT STARTING");
  console.log("=".repeat(60));
  console.log(`[sniper] WebSocket RPC: ${WS_RPC_URL}`);
  console.log(`[sniper] Clanker Factory: ${CLANKER_FACTORY}`);
  console.log(`[sniper] Zora Factory: ${ZORA_FACTORY}`);
  console.log(`[sniper] Create Alerts: ${SNIPER_ALERT_ON_CREATE ? "ON" : "OFF"} (fast=${SNIPER_FAST_TIMEOUT_MS}ms)`);
  console.log(
    `[sniper] Liquidity Alerts: ${SNIPER_ALERT_ON_LIQUIDITY ? "ON" : "OFF"} (after-create=${SNIPER_LIQUIDITY_ALERT_AFTER_CREATE ? "ON" : "OFF"})`,
  );
  console.log(
    `[sniper] Slow Fallback: ${SNIPER_ENABLE_SLOW_FALLBACK ? "ON" : "OFF"} (concurrency=${SNIPER_SLOW_VALIDATION_CONCURRENCY})`,
  );
  console.log(
    `[sniper] Neynar Gate: ${
      SNIPER_NEYNAR_GATE_ENABLED ? "ON" : "OFF"
    } (min=${(SNIPER_MIN_NEYNAR_SCORE * 100).toFixed(0)}%)`,
  );
  console.log(`[sniper] Min Twitter: ${MIN_TWITTER_MINIMUM.toLocaleString()}`);
  console.log(`[sniper] Min Farcaster: ${MIN_FARCASTER_FOLLOWERS.toLocaleString()}`);
  console.log(`[sniper] Min Liquidity: $${MIN_LIQUIDITY_USD.toLocaleString()}`);
  console.log(`[sniper] Watch Time: ${WATCHLIST_MAX_AGE_MS / 60000} minutes`);
  console.log(`[sniper] VIP Content Coins: @base, @jacob, @zora`);

  // Auto-buy status
  const autoBuyStatus = isAutoBuyReady();
  if (autoBuyStatus.ready) {
    const walletInfo = await getWalletInfo();
    console.log(`[sniper] 🛒 AUTO-BUY: ENABLED`);
    console.log(`[sniper]    Wallet: ${walletInfo?.address ?? "unknown"}`);
    console.log(`[sniper]    Balance: ${walletInfo?.balanceEth ?? "0"} ETH`);
    console.log(`[sniper]    Amount: ${autoBuyStatus.config.amountEth} ETH per trade`);
    console.log(`[sniper]    Daily Limit: ${autoBuyStatus.config.maxDailyEth} ETH`);
    console.log(`[sniper]    Slippage: ${autoBuyStatus.config.slippagePercent}%`);
  } else {
    console.log(`[sniper] 🛒 AUTO-BUY: DISABLED`);
    if (!autoBuyStatus.walletConfigured) {
      console.log(`[sniper]    (Set AUTOBUY_PRIVATE_KEY and AUTOBUY_ENABLED=true to enable)`);
    }
  }
  console.log("=".repeat(60));

  // Send startup notification
  const autoBuyMsg = autoBuyStatus.ready
    ? `\n• Auto-Buy: ENABLED (${autoBuyStatus.config.amountEth} ETH)`
    : "\n• Auto-Buy: DISABLED";
  void sendSimpleMessage(
    `🎯 Sniper Bot started\n• Create Alerts: ${SNIPER_ALERT_ON_CREATE ? "ON" : "OFF"}\n• Liquidity Alerts: ${SNIPER_ALERT_ON_LIQUIDITY ? "ON" : "OFF"}\n• Min Liquidity: $${MIN_LIQUIDITY_USD.toLocaleString()}\n• Watch Time: 1 hour${autoBuyMsg}`,
  );

  // Create WebSocket client
  const client = createPublicClient({
    chain: base,
    transport: webSocket(WS_RPC_URL, {
      reconnect: true,
      retryCount: 10,
      retryDelay: 1000,
    }),
  });

  console.log("[sniper] Connecting to WebSocket...");

  // Test connection
  let connectedBlock = BigInt(0);
  try {
    connectedBlock = await client.getBlockNumber();
    console.log(`[sniper] ✅ Connected! Current block: ${connectedBlock}`);
  } catch (error) {
    console.error("[sniper] ❌ Failed to connect to WebSocket:", error);
    process.exit(1);
  }

  // Load or initialize cursor so restarts can backfill missed logs.
  sniperLastSeenBlock = await readSniperCursor();
  if (sniperLastSeenBlock === null) {
    sniperLastSeenBlock = connectedBlock;
    sniperCursorDirty = true;
    console.log(`[sniper] Cursor initialized at block ${sniperLastSeenBlock}`);
  } else {
    console.log(`[sniper] Cursor loaded: ${sniperLastSeenBlock}`);
  }

  const cursorInterval = setInterval(() => {
    void flushSniperCursor();
  }, SNIPER_CURSOR_FLUSH_MS);
  cursorInterval.unref?.();

  // Track connection health
  let lastBlockSeen = BigInt(0);
  let lastEventAt = Date.now();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;
  let isResubscribing = false;
  let lastResubscribeAt = 0;
  let lastStaleProbeAt = 0;
  let lastStaleWarningAt = 0;
  let lastNodeStallWarningAt = 0;
  let stalledSince: number | null = null;

  // Store unwatch functions for circuit breaker resubscribe
  let unwatchClanker: (() => void) | null = null;
  let unwatchZora: (() => void) | null = null;
  let unwatchVIP: (() => void) | null = null;

  const runEventTask = createConcurrencyLimiter(SNIPER_EVENT_CONCURRENCY);

  // Opportunistic backfill: fetch recent logs around the persisted cursor.
  try {
    await backfillRecentEvents(client, runEventTask);
  } catch (error) {
    console.warn(
      "[sniper] Backfill failed (continuing):",
      error instanceof Error ? error.message : error,
    );
  }

  // Circuit breaker resubscribe function
  async function resubscribeAll(reason: string) {
    if (isResubscribing) return;
    const now = Date.now();
    if (
      SNIPER_RESUBSCRIBE_COOLDOWN_MS > 0 &&
      now - lastResubscribeAt < SNIPER_RESUBSCRIBE_COOLDOWN_MS
    ) {
      const waitMs = SNIPER_RESUBSCRIBE_COOLDOWN_MS - (now - lastResubscribeAt);
      console.warn(
        `[sniper] 🔁 Resubscribe suppressed (cooldown ${Math.ceil(waitMs / 1000)}s) reason=${reason}`,
      );
      return;
    }
    lastResubscribeAt = now;
    isResubscribing = true;

    console.log(`[sniper] 🔄 Resubscribing to all events (reason=${reason})...`);
    await sendSimpleMessage(
      `🔄 Sniper: resubscribing...\n• Reason: ${reason}`,
    );

    // Unsubscribe from all
    try {
      if (unwatchClanker) unwatchClanker();
      if (unwatchZora) unwatchZora();
      if (unwatchVIP) unwatchVIP();
    } catch (e) {
      console.error("[sniper] Error during unsubscribe:", e);
    }

    // Wait a bit before resubscribing
    await new Promise(r => setTimeout(r, 2000));

    // Resubscribe
    try {
      subscribeClanker();
      subscribeZora();
      subscribeVIP();
      consecutiveErrors = 0;
      console.log("[sniper] ✅ Resubscribed to all events successfully");
      await sendSimpleMessage("✅ Sniper: Resubscribed successfully");
    } catch (e) {
      console.error("[sniper] ❌ Failed to resubscribe:", e);
      await sendSimpleMessage(`❌ Sniper: Resubscribe failed - ${e instanceof Error ? e.message : "Unknown error"}`);
    }

    isResubscribing = false;
  }

  // Subscribe functions for circuit breaker
  function subscribeClanker() {
    console.log("[sniper] Subscribing to Clanker factory events...");
    unwatchClanker = client.watchContractEvent({
      address: CLANKER_FACTORY as `0x${string}`,
      abi: [CLANKER_TOKEN_CREATED, POOL_CREATED],
      onLogs: (logs) => {
        consecutiveErrors = 0;
        lastEventAt = Date.now();
        for (const log of logs) {
          const eventId = getEventId(log);
          if (processedEventIds.has(eventId)) {
            continue;
          }
          processedEventIds.set(eventId, true);
          markSniperCursor(log.blockNumber);

          if (log.blockNumber && log.blockNumber > lastBlockSeen) {
            lastBlockSeen = log.blockNumber;
          }
          void runEventTask(async () => {
            try {
              await handleClankerEvent(log);
            } catch (error) {
              processedEventIds.delete(eventId);
              console.error(`[sniper] Error handling Clanker event:`, error);
            }
          });
        }
      },
      onError: async (error) => {
        consecutiveErrors++;
        console.error(`[sniper] Clanker watch error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          await resubscribeAll("clanker watch error");
        }
      },
    });
  }

  function subscribeZora() {
    console.log("[sniper] Subscribing to Zora factory events (Legacy + CreatorCoinCreated V1 + V2)...");
    unwatchZora = client.watchContractEvent({
      address: ZORA_FACTORY as `0x${string}`,
      abi: [ZORA_COIN_CREATED, ZORA_CREATOR_COIN_CREATED, ZORA_CREATOR_COIN_CREATED_V2],
      onLogs: (logs) => {
        consecutiveErrors = 0;
        lastEventAt = Date.now();
        for (const log of logs) {
          const eventId = getEventId(log);
          if (processedEventIds.has(eventId)) {
            continue;
          }
          processedEventIds.set(eventId, true);
          markSniperCursor(log.blockNumber);

          if (log.blockNumber && log.blockNumber > lastBlockSeen) {
            lastBlockSeen = log.blockNumber;
          }
          void runEventTask(async () => {
            try {
              await handleZoraEvent(log);
            } catch (error) {
              processedEventIds.delete(eventId);
              console.error(`[sniper] Error handling Zora event:`, error);
            }
          });
        }
      },
      onError: async (error) => {
        consecutiveErrors++;
        console.error(`[sniper] Zora watch error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          await resubscribeAll("zora watch error");
        }
      },
    });
  }

  function subscribeVIP() {
    console.log("[sniper] Subscribing to Zora VIP content coins (CoinCreatedV4 from @base, @jacob, @zora)...");
    unwatchVIP = client.watchContractEvent({
      address: ZORA_FACTORY as `0x${string}`,
      abi: [ZORA_COIN_CREATED_V4],
      onLogs: (logs) => {
        consecutiveErrors = 0;
        lastEventAt = Date.now();
        for (const log of logs) {
          const eventId = getEventId(log);
          if (processedEventIds.has(eventId)) {
            continue;
          }
          processedEventIds.set(eventId, true);
          markSniperCursor(log.blockNumber);

          if (log.blockNumber && log.blockNumber > lastBlockSeen) {
            lastBlockSeen = log.blockNumber;
          }
          void runEventTask(async () => {
            try {
              await handleZoraVIPEvent(log);
            } catch (error) {
              processedEventIds.delete(eventId);
              console.error(`[sniper] Error handling Zora VIP event:`, error);
            }
          });
        }
      },
      onError: async (error) => {
        // Don't count VIP watch errors as critical - they're supplementary
        console.error(`[sniper] Zora VIP watch error:`, error);
      },
    });
  }

  // Initial subscriptions
  subscribeClanker();
  subscribeZora();
  subscribeVIP();

  console.log("[sniper] 🎧 Listening for new tokens...\n");

  // Start watchlist liquidity monitoring
  startWatchlistLoop();

  // Periodic pruning for long-running process hygiene
  const pruneInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, data] of creatorTokenCount.entries()) {
      if (now - data.firstSeen > CREATOR_WINDOW_MS) {
        creatorTokenCount.delete(key);
      }
    }
    const pruned = processedEventIds.prune();
    if (pruned > 0) {
      console.log(`[sniper] 🧹 Pruned ${pruned} dedup entries`);
    }
  }, Number(process.env.SNIPER_PRUNE_INTERVAL_MS ?? 60 * 60 * 1000));
  pruneInterval.unref?.();

  // Keep alive
  process.on("SIGINT", async () => {
    console.log("\n[sniper] Shutting down...");
    await sendSimpleMessage("🛑 Sniper Bot shutting down...");
    if (unwatchClanker) unwatchClanker();
    if (unwatchZora) unwatchZora();
    if (unwatchVIP) unwatchVIP();
    await flushSniperCursor();
    process.exit(0);
  });

  const probeRecentFactoryLogs = async (toBlock: bigint): Promise<number> => {
    if (SNIPER_STALE_PROBE_BLOCKS <= 0n) return 0;
    const fromBlock =
      toBlock > SNIPER_STALE_PROBE_BLOCKS ? toBlock - SNIPER_STALE_PROBE_BLOCKS : 0n;
    if (fromBlock >= toBlock) return 0;

    const results = await Promise.allSettled([
      client.getLogs({
        address: CLANKER_FACTORY as `0x${string}`,
        event: CLANKER_TOKEN_CREATED,
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address: ZORA_FACTORY as `0x${string}`,
        event: ZORA_COIN_CREATED,
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address: ZORA_FACTORY as `0x${string}`,
        event: ZORA_CREATOR_COIN_CREATED,
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address: ZORA_FACTORY as `0x${string}`,
        event: ZORA_CREATOR_COIN_CREATED_V2,
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address: ZORA_FACTORY as `0x${string}`,
        event: ZORA_COIN_CREATED_V4,
        fromBlock,
        toBlock,
      }),
    ]);

    let found = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        found += (result.value as Log[]).length;
      }
    }

    return found;
  };

  // Health check and heartbeat every 60 seconds
  let lastHealthCheckBlock = BigInt(0);
  setInterval(async () => {
    try {
      const currentBlock = await client.getBlockNumber();
      const blockProgress = currentBlock - lastHealthCheckBlock;
      lastHealthCheckBlock = currentBlock;

      const now = Date.now();
      const timeSinceLastEvent = now - lastEventAt;
      const eventAgeMinutes = Math.floor(timeSinceLastEvent / 60000);

      // Check Zora API health
      const apiHealthy = await checkZoraApiHealth();
      const apiStatus = apiHealthy ? "🟢" : "🔴";

      console.log(`[sniper] ♥️ Heartbeat - Block: ${currentBlock} (+${blockProgress}) - Last event: ${eventAgeMinutes}m ago - Zora API: ${apiStatus} - ${new Date().toISOString()}`);

      if (blockProgress === BigInt(0)) {
        if (stalledSince === null) {
          stalledSince = now;
        }
        const stalledMs = now - stalledSince;
        if (
          SNIPER_STALE_WARNING_INTERVAL_MS === 0 ||
          now - lastNodeStallWarningAt >= SNIPER_STALE_WARNING_INTERVAL_MS
        ) {
          lastNodeStallWarningAt = now;
          console.warn(
            `[sniper] ⚠️ Block number not advancing for ${Math.floor(stalledMs / 60000)}m - check local node + WS_RPC_URL`,
          );
        }
      } else {
        stalledSince = null;
      }

      // Check if events are stale (no events received for too long)
      if (timeSinceLastEvent > SNIPER_EVENT_STALE_THRESHOLD_MS) {
        if (
          SNIPER_STALE_WARNING_INTERVAL_MS === 0 ||
          now - lastStaleWarningAt >= SNIPER_STALE_WARNING_INTERVAL_MS
        ) {
          lastStaleWarningAt = now;
          console.warn(
            `[sniper] ⚠️ No factory events received in ${eventAgeMinutes} minutes`,
          );
        }

        // If the node isn't advancing, resubscribing won't help.
        if (blockProgress === BigInt(0)) {
          return;
        }

        if (
          SNIPER_STALE_PROBE_INTERVAL_MS === 0 ||
          now - lastStaleProbeAt >= SNIPER_STALE_PROBE_INTERVAL_MS
        ) {
          lastStaleProbeAt = now;
          const found = await probeRecentFactoryLogs(currentBlock);
          if (found > 0) {
            console.error(
              `[sniper] ❌ Missed ${found} factory logs in last ${SNIPER_STALE_PROBE_BLOCKS.toString()} blocks - resubscribing`,
            );
            await resubscribeAll(`stale subscription (missed ${found} logs)`);
          } else {
            console.log(
              `[sniper] 🔎 Stale probe: no factory logs in last ${SNIPER_STALE_PROBE_BLOCKS.toString()} blocks; staying subscribed`,
            );
          }
        }
      }
    } catch (error) {
      console.error("[sniper] ❌ Health check failed:", error);
      await sendSimpleMessage(`⚠️ Sniper health check failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }, 60000);

  // Hourly status update disabled (spam)
  // setInterval(async () => {
  //   const uptime = process.uptime();
  //   const hours = Math.floor(uptime / 3600);
  //   const minutes = Math.floor((uptime % 3600) / 60);
  //   await sendSimpleMessage(`📊 Sniper Status: Running for ${hours}h ${minutes}m | Last block: ${lastBlockSeen}`);
  // }, 3600000);
}

main().catch(async (error) => {
  console.error("[sniper] Fatal error:", error);
  await sendSimpleMessage(`❌ Sniper Bot crashed: ${error instanceof Error ? error.message : "Unknown error"}`);
  await flushSniperCursor();
  process.exit(1);
});
