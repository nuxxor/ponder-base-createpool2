import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_POLL_INTERVAL_MS,
  SNAPSHOT_FILE,
  WATCHLIST_FILE,
  WATCH_DATA_DIR,
} from "../constants";
import { CommunityLinks } from "../types/community";
import { normalizeAddress } from "./address";

const dataDir = path.resolve(process.cwd(), WATCH_DATA_DIR);
const watchlistPath = path.join(dataDir, WATCHLIST_FILE);
const snapshotPath = path.join(dataDir, SNAPSHOT_FILE);

const ensureDataDir = async () => {
  await fs.mkdir(dataDir, { recursive: true });
};

type AsyncTask = () => Promise<void>;

const fileLocks = new Map<string, Promise<void>>();

const runWithFileLock = async (filePath: string, task: AsyncTask) => {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (fileLocks.get(filePath) === next) {
        fileLocks.delete(filePath);
      }
    });
  fileLocks.set(filePath, next);
  await next;
};

export const nowIso = () => new Date().toISOString();

export type PoolRef = {
  poolAddress: string;
  quoteToken: string;
  protocol: string;
  factoryAddress: string;
  blockNumber: number;
  blockTimestamp: number;
};

export type WatchEntry = {
  token: string;
  status: "active" | "dropped";
  firstSeen: string;
  pools: PoolRef[];
  quoteTokens: string[];
  lastSnapshotAt?: string;
  droppedReason?: string;
  lastMetrics?: TokenMetricsSnapshot;
  notes?: string;
  consecutiveHealthyCycles?: number;
  lastLiquidityUsd?: number;
  security?: SecurityReport;
  community?: CommunityLinks;
};

export type Watchlist = {
  version: 1;
  createdAt: string;
  updatedAt: string;
  pollIntervalMs: number;
  tokens: Record<string, WatchEntry>;
};

export type TokenMetricsSnapshot = {
  token: string;
  collectedAt: string;
  totalLiquidityUsd: number;
  totalVolumeH1: number;
  totalVolumeH24: number;
  totalBuysH1: number;
  totalSellsH1: number;
  totalBuysH24: number;
  totalSellsH24: number;
  buySellRatioH1: number;
  buySellRatioH24: number;
  priceUsd?: number;
  priceChangeH1?: number;
  priceChangeH24?: number;
  bestPair?: {
    pairAddress: string;
    dexId?: string;
    url?: string;
    liquidityUsd?: number;
    marketCap?: number | null;
    fdv?: number | null;
    labels?: string[];
  };
  community?: CommunityLinks;
};

export type EvaluationResult = {
  action: "watch" | "drop";
  score: number;
  reason?: string;
  notes?: string;
  warnings?: string[];
  riskFlags?: string[];
};

export type SecurityReport = {
  owner?: {
    address?: string | null;
    renounced: boolean;
    checkedAt: string;
  };
  lp?: {
    type: "v2" | "v3" | "unknown";
    poolAddress?: string;
    lockedPercent?: number;
    lockerBreakdown?: { address: string; percent: number }[];
    checkedAt: string;
  };
  riskFlags?: string[];
};

export type SnapshotRecord = {
  token: string;
  metrics: TokenMetricsSnapshot;
  evaluation: EvaluationResult;
};

const defaultWatchlist = (): Watchlist => ({
  version: 1,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  tokens: {},
});

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      const backupPath = `${filePath}.${Date.now()}.corrupted`;
      try {
        await fs.rename(filePath, backupPath);
        console.warn(
          `[watchlist] Detected corrupt JSON. Moved ${filePath} -> ${backupPath}`,
        );
      } catch (renameError) {
        console.warn(
          `[watchlist] Failed to move corrupt JSON for ${filePath}`,
          renameError,
        );
      }
      return null;
    }
    throw error;
  }
};

const writeJsonFile = async (filePath: string, data: unknown) => {
  await ensureDataDir();
  const payload = JSON.stringify(data, null, 2) + "\n";
  const tmpPath = `${filePath}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  await runWithFileLock(filePath, async () => {
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, filePath);
  });
};

export const readWatchlist = async (): Promise<Watchlist> => {
  const existing = await readJsonFile<Watchlist>(watchlistPath);
  if (existing) {
    return existing;
  }
  const fresh = defaultWatchlist();
  await writeJsonFile(watchlistPath, fresh);
  return fresh;
};

export const writeWatchlist = async (watchlist: Watchlist) => {
  watchlist.updatedAt = nowIso();
  await writeJsonFile(watchlistPath, watchlist);
};

export const updateWatchlist = async (
  mutator: (draft: Watchlist) => Watchlist | void | Promise<Watchlist | void>,
) => {
  const current = await readWatchlist();
  const draft = structuredClone(current);
  const mutated = (await mutator(draft)) ?? draft;
  if (JSON.stringify(mutated) === JSON.stringify(current)) {
    return;
  }
  await writeWatchlist(mutated);
};

export type TrackTokenCandidatePayload = {
  tokenAddress: string;
  quoteTokenAddress: string;
  poolAddress: string;
  protocol: string;
  factoryAddress: string;
  blockNumber: number;
  blockTimestamp: number;
};

export const trackTokenCandidate = async (
  payload: TrackTokenCandidatePayload,
) => {
  const normalizedToken = normalizeAddress(payload.tokenAddress);
  const normalizedQuote = normalizeAddress(payload.quoteTokenAddress);

  await updateWatchlist((watchlist) => {
    const entry = watchlist.tokens[normalizedToken];
    const poolRef: PoolRef = {
      poolAddress: normalizeAddress(payload.poolAddress),
      quoteToken: normalizedQuote,
      protocol: payload.protocol,
      factoryAddress: normalizeAddress(payload.factoryAddress),
      blockNumber: payload.blockNumber,
      blockTimestamp: payload.blockTimestamp,
    };

    if (entry) {
      const hasPool = entry.pools.some(
        (pool) => pool.poolAddress === poolRef.poolAddress,
      );
      if (!hasPool) {
        entry.pools.push(poolRef);
      }
      if (!entry.quoteTokens.includes(normalizedQuote)) {
        entry.quoteTokens.push(normalizedQuote);
      }
      if (entry.status === "dropped") {
        entry.status = "active";
        entry.droppedReason = undefined;
      }
      entry.notes = `Updated via pool ${poolRef.poolAddress} on ${nowIso()}`;
      return watchlist;
    }

    watchlist.tokens[normalizedToken] = {
      token: normalizedToken,
      status: "active",
      firstSeen: new Date(payload.blockTimestamp * 1000).toISOString(),
      pools: [poolRef],
      quoteTokens: [normalizedQuote],
    };

    return watchlist;
  });
};

export const appendSnapshotRecord = async (record: SnapshotRecord) => {
  await ensureDataDir();
  const line = JSON.stringify(record);
  await runWithFileLock(snapshotPath, async () => {
    await fs.appendFile(snapshotPath, line + "\n", "utf8");
  });
};
