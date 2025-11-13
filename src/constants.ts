export const BASE_ANCHOR_TOKENS = new Set(
  [
    "0x4200000000000000000000000000000000000006", // WETH
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    "0xd9aeec8b45db9eccbdf4c21bbfb9333d5859159f", // USDbC (bridged USDC)
  ].map((address) => address.toLowerCase()),
);

export const WATCH_DATA_DIR = "data";
export const WATCHLIST_FILE = "watchlist.json";
export const SNAPSHOT_FILE = "dex_snapshots.ndjson";
export const PROMISING_TOKENS_FILE = "promising.json";

export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

export const MIN_HEALTHY_LIQUIDITY_USD = 15_000;
export const MIN_BUYS_PER_HOUR = 10;
export const MIN_BUY_SELL_RATIO = 0.65;
export const DROP_LIQUIDITY_THRESHOLD_USD = 2_000;
export const DROP_PRICE_CHANGE_THRESHOLD = -75;
export const PROMISING_SCORE_THRESHOLD = 3;
export const MIN_VOLUME_H1_USD = 10_000;
export const MAX_MARKETCAP_LIQUIDITY_RATIO = 500;
export const LIQUIDITY_DROP_PERCENT = 0.8;
export const LIQUIDITY_DROP_MIN_BASE = 5_000;
export const MIN_CONSECUTIVE_HEALTHY_CYCLES = 3;
export const SUSPICIOUS_LABELS = ["honeypot", "rugpull", "scam", "suspicious"];
export const SECURITY_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
export const MAX_SECURITY_CHECKS_PER_CYCLE = 5;
export const MIN_LOCKED_LP_PERCENT = 50;
export const BASESCAN_API_URL = "https://api.basescan.org/v2/api";
export const BASESCAN_API_KEY =
  process.env.BASESCAN_API_KEY ?? "UA3SCUYC6D3IVBP9E4613ES89KEQNJR27X";
export const BASESCAN_MIN_DELAY_MS = 250; // 4 req/s (~5 req/s limit)
export const LOCK_DESTINATIONS = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "0x000000000000000000000000000000000000dEaD",
  "0x0000000000000000000000000000000000000001",
  // Known locker contracts (examples)
  "0x000000000000000000000000000000000000000d", // Burn
  "0x38d9c40a2b7c1844c3af06b6ade24c7cfb056c1c", // Team Finance
  "0x3D7F49176e41Cb9162Bbb7D0D06b2ecF6754DDe4", // Unicrypt (example)
];
