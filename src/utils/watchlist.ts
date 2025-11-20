import { promises as fs } from "node:fs";
import path from "node:path";

import "../env";

import {
  DEFAULT_POLL_INTERVAL_MS,
  SNAPSHOT_FILE,
  WATCHLIST_FILE,
  WATCH_DATA_DIR,
} from "../constants";
import { CommunityLinks, SocialLink } from "../types/community";
import {
  Identity,
  LaunchSchedule,
  NewTokenCandidate,
  Platform,
  SmartFollowerReport,
  SocialStat,
  TokenMeta,
} from "../types/newToken";
import { ScoreResult } from "../types/score";
import { normalizeAddress } from "./address";

const WATCHLIST_ALLOWED_PLATFORMS = new Set(
  (process.env.WATCHLIST_ALLOWED_PLATFORMS ?? "zora,clanker")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

export const isWatchlistPlatformAllowed = (
  platform?: Platform | string | null,
) => {
  if (!platform) return false;
  return WATCHLIST_ALLOWED_PLATFORMS.has(platform.toLowerCase());
};

const dataDir = path.resolve(process.cwd(), WATCH_DATA_DIR);
const watchlistPath = path.join(dataDir, WATCHLIST_FILE);
const snapshotPath = path.join(dataDir, SNAPSHOT_FILE);
type SocialEntry = SocialLink;
type RawSocialEntry = SocialLink;

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
  platform?: Platform;
  identity?: Identity;
  schedule?: LaunchSchedule;
  tokenMeta?: TokenMeta;
  labels?: string[];
  scores?: Record<string, ScoreResult>;
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

const pruneWatchlistByPlatform = async (
  watchlist: Watchlist,
): Promise<Watchlist> => {
  const disallowed = Object.entries(watchlist.tokens).filter(
    ([, entry]) => !isWatchlistPlatformAllowed(entry.platform),
  );
  if (disallowed.length === 0) return watchlist;
  for (const [token] of disallowed) {
    delete watchlist.tokens[token];
  }
  watchlist.updatedAt = nowIso();
  console.warn(
    `[watchlist] Removed ${disallowed.length} token(s) outside allowed platforms`,
  );
  await writeJsonFile(watchlistPath, watchlist);
  return watchlist;
};

export const readWatchlist = async (): Promise<Watchlist> => {
  const existing = await readJsonFile<Watchlist>(watchlistPath);
  if (existing) {
    return pruneWatchlistByPlatform(existing);
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

const MERGE_CHAIN_ID = 8453;
const unique = <T>(values: (T | undefined | null)[]): T[] => {
  const set = new Set<T>();
  for (const value of values) {
    if (value !== undefined && value !== null) {
      set.add(value);
    }
  }
  return Array.from(set);
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
      entry.tokenMeta = mergeTokenMeta(entry.tokenMeta, {
        chainId: MERGE_CHAIN_ID,
        address: normalizedToken as `0x${string}`,
        poolAddress: poolRef.poolAddress as `0x${string}`,
        factory: poolRef.factoryAddress as `0x${string}`,
        quote: normalizedQuote as `0x${string}`,
        createdAt: new Date(payload.blockTimestamp * 1000).toISOString(),
      });
      entry.notes = `Updated via pool ${poolRef.poolAddress} on ${nowIso()}`;
      return watchlist;
    }

    watchlist.tokens[normalizedToken] = {
      token: normalizedToken,
      status: "active",
      firstSeen: new Date(payload.blockTimestamp * 1000).toISOString(),
      pools: [poolRef],
      quoteTokens: [normalizedQuote],
      tokenMeta: {
        chainId: MERGE_CHAIN_ID,
        address: normalizedToken as `0x${string}`,
        poolAddress: poolRef.poolAddress as `0x${string}`,
        factory: poolRef.factoryAddress as `0x${string}`,
        quote: normalizedQuote as `0x${string}`,
        createdAt: new Date(payload.blockTimestamp * 1000).toISOString(),
      },
    };

    return watchlist;
  });
};

export const mergeCommunityLinks = (
  current?: CommunityLinks,
  incoming?: CommunityLinks,
): CommunityLinks | undefined => {
  if (!incoming) return current;
  if (!current) return structuredClone(incoming);

  const websites = unique([
    ...(current.websites ?? []),
    ...(incoming.websites ?? []),
  ]);

  const socialsMap = new Map<string, SocialEntry>();
  current.socials?.forEach((link) =>
    socialsMap.set(link.platform.toLowerCase(), link),
  );
  incoming.socials?.forEach((link) => {
    const key = link.platform.toLowerCase();
    if (!socialsMap.has(key)) {
      socialsMap.set(key, link);
    }
  });

  const rawSocialsMap = new Map<string, RawSocialEntry>();
  current.raw?.forEach((link) =>
    rawSocialsMap.set(`${link.platform}:${link.url}`, link),
  );
  incoming.raw?.forEach((link) => {
    const key = `${link.platform}:${link.url}`;
    if (!rawSocialsMap.has(key)) {
      rawSocialsMap.set(key, link);
    }
  });

  return {
    primaryWebsite: current.primaryWebsite ?? incoming.primaryWebsite,
    twitter: current.twitter ?? incoming.twitter,
    telegram: current.telegram ?? incoming.telegram,
    discord: current.discord ?? incoming.discord,
    github: current.github ?? incoming.github,
    websites: websites.length ? websites : undefined,
    socials: socialsMap.size ? Array.from(socialsMap.values()) : undefined,
    raw: rawSocialsMap.size
      ? Array.from(rawSocialsMap.values())
      : current.raw ?? incoming.raw,
  };
};

const mergeIdentity = (
  current?: Identity,
  incoming?: Identity,
): Identity | undefined => {
  if (!incoming) return current;
  if (!current) return structuredClone(incoming);

  return {
    platform: current.platform ?? incoming.platform,
    creatorFid: current.creatorFid ?? incoming.creatorFid,
    custodyAddress: current.custodyAddress ?? incoming.custodyAddress,
    verifiedAddrs: unique([
      ...(current.verifiedAddrs ?? []),
      ...(incoming.verifiedAddrs ?? []),
    ]),
    twitter: current.twitter ?? incoming.twitter,
    github: current.github ?? incoming.github,
    website: current.website ?? incoming.website,
    farcasterUsername: current.farcasterUsername ?? incoming.farcasterUsername,
    score: Math.max(current.score ?? 0, incoming.score ?? 0),
    smartAccount: current.smartAccount ?? incoming.smartAccount,
    launchCount:
      current.launchCount !== undefined || incoming.launchCount !== undefined
        ? Math.max(current.launchCount ?? 0, incoming.launchCount ?? 0)
        : undefined,
    socialStats: mergeSocialStats(current.socialStats, incoming.socialStats),
    smartFollowers: mergeSmartFollowerReport(
      current.smartFollowers,
      incoming.smartFollowers,
    ),
  };
};

const mergeTokenMeta = (
  current?: TokenMeta,
  incoming?: Partial<TokenMeta>,
): TokenMeta | undefined => {
  if (!incoming) return current;
  if (!current) return structuredClone(incoming) as TokenMeta;

  return {
    chainId: current.chainId ?? incoming.chainId ?? MERGE_CHAIN_ID,
    address: (current.address ?? incoming.address) as `0x${string}`,
    symbol: current.symbol ?? incoming.symbol,
    name: current.name ?? incoming.name,
    decimals: current.decimals ?? incoming.decimals,
    createdAt: current.createdAt ?? incoming.createdAt,
    poolAddress: current.poolAddress ?? incoming.poolAddress,
    feeTier: current.feeTier ?? incoming.feeTier,
    stable: current.stable ?? incoming.stable,
    factory: current.factory ?? incoming.factory,
    txHash: current.txHash ?? incoming.txHash,
    quote: current.quote ?? incoming.quote,
  };
};

const mergeSchedule = (
  current?: LaunchSchedule,
  incoming?: LaunchSchedule,
): LaunchSchedule | undefined => {
  if (!incoming) return current;
  if (!current) return structuredClone(incoming);
  return {
    scheduledAt: current.scheduledAt ?? incoming.scheduledAt,
    lpDeployedAt: current.lpDeployedAt ?? incoming.lpDeployedAt,
    graduationAt: current.graduationAt ?? incoming.graduationAt,
    source: current.source ?? incoming.source,
  };
};

const mergeSecurityFromCandidate = (
  current?: SecurityReport,
  candidate?: NewTokenCandidate["security"],
): SecurityReport | undefined => {
  if (!candidate) return current;
  const next: SecurityReport = current
    ? structuredClone(current)
    : {
        owner: undefined,
        lp: undefined,
        riskFlags: [],
      };

  if (candidate.owner) {
    const now = nowIso();
    if (candidate.owner === "renounced") {
      next.owner = {
        address: null,
        renounced: true,
        checkedAt: now,
      };
    } else if (candidate.owner === "unknown") {
      next.owner = {
        address: next.owner?.address ?? undefined,
        renounced: next.owner?.renounced ?? false,
        checkedAt: next.owner?.checkedAt ?? now,
      };
    } else {
      next.owner = {
        address: candidate.owner,
        renounced: false,
        checkedAt: now,
      };
    }
  }

  if (candidate.lpLock) {
    next.lp = {
      type: next.lp?.type ?? "v2",
      poolAddress: next.lp?.poolAddress,
      lockedPercent: candidate.lpLock.percent ?? next.lp?.lockedPercent,
      lockerBreakdown: next.lp?.lockerBreakdown,
      checkedAt: nowIso(),
    };
  }

  if (candidate.labels?.length) {
    next.riskFlags = unique([...(next.riskFlags ?? []), ...candidate.labels]);
  }

  return next;
};

export const upsertNewTokenCandidate = async (
  candidate: NewTokenCandidate,
) => {
  if (!isWatchlistPlatformAllowed(candidate.platform)) {
    console.log(
      `[watchlist] Ignoring ${candidate.token.address} from ${candidate.platform}`,
    );
    return;
  }
  const normalizedToken = normalizeAddress(candidate.token.address);

  await updateWatchlist((watchlist) => {
    const entry =
      watchlist.tokens[normalizedToken] ??
      (watchlist.tokens[normalizedToken] = {
        token: normalizedToken,
        status: "active",
        firstSeen: candidate.token.createdAt ?? nowIso(),
        pools: [],
        quoteTokens: [],
      });

    entry.platform = candidate.platform;
    entry.identity = mergeIdentity(entry.identity, candidate.identity);
    entry.schedule = mergeSchedule(entry.schedule, candidate.schedule);
    entry.community = mergeCommunityLinks(entry.community, candidate.community);
    entry.tokenMeta = mergeTokenMeta(entry.tokenMeta, candidate.token);
    entry.security = mergeSecurityFromCandidate(entry.security, candidate.security);
    if (candidate.community?.twitter && !entry.community?.twitter) {
      entry.community = entry.community ?? {};
      entry.community.twitter = candidate.community.twitter;
    }
    if (candidate.security?.labels?.length) {
      entry.labels = unique([...(entry.labels ?? []), ...candidate.security.labels]);
    }

    if (candidate.token.quote) {
      const quote = normalizeAddress(candidate.token.quote);
      if (!entry.quoteTokens.includes(quote)) {
        entry.quoteTokens.push(quote);
      }
    }

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

export const upsertScore = async (token: string, score: ScoreResult) => {
  const normalizedToken = normalizeAddress(token);
  await updateWatchlist((watchlist) => {
    const entry = watchlist.tokens[normalizedToken];
    if (!entry) return;
    entry.scores = entry.scores ?? {};
    entry.scores[score.platform] = score;
    return watchlist;
  });
};
const mergeSocialStat = (
  current?: SocialStat,
  incoming?: SocialStat,
): SocialStat | undefined => {
  if (!incoming) return current ? structuredClone(current) : undefined;
  if (!current) return structuredClone(incoming);
  const currentTime = current.lastCheckedAt
    ? new Date(current.lastCheckedAt).getTime()
    : 0;
  const incomingTime = incoming.lastCheckedAt
    ? new Date(incoming.lastCheckedAt).getTime()
    : 0;
  if (
    incomingTime > currentTime ||
    current.handle?.toLowerCase() !== incoming.handle?.toLowerCase()
  ) {
    return structuredClone(incoming);
  }
  return structuredClone(current);
};

const mergeSocialStats = (
  current?: Identity["socialStats"],
  incoming?: Identity["socialStats"],
) => {
  if (!incoming) return current ? structuredClone(current) : undefined;
  if (!current) return structuredClone(incoming);
  return {
    twitter: mergeSocialStat(current.twitter, incoming.twitter),
    farcaster: mergeSocialStat(current.farcaster, incoming.farcaster),
  };
};

const mergeSmartFollowerReport = (
  current?: SmartFollowerReport,
  incoming?: SmartFollowerReport,
): SmartFollowerReport | undefined => {
  if (!incoming) return current ? structuredClone(current) : undefined;
  if (!current) return structuredClone(incoming);
  const currentTime = current.lastCheckedAt
    ? new Date(current.lastCheckedAt).getTime()
    : 0;
  const incomingTime = incoming.lastCheckedAt
    ? new Date(incoming.lastCheckedAt).getTime()
    : 0;
  if (incomingTime >= currentTime) {
      return structuredClone(incoming);
  }
  return structuredClone(current);
};
