import "../env";

import { NewTokenCandidate } from "../types/newToken";
import { resolveFarcasterIdentity } from "./farcaster";
import { LRUCache } from "../utils/lruCache";
import { withRetry } from "../utils/retry";

const CLANKER_API = "https://www.clanker.world/api/tokens";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// LRU cache with max 1000 entries and 1 hour TTL to prevent memory leak
const launchCountCache = new LRUCache<number, Promise<number | undefined>>(1000, 3600000);

export interface ClankerSocial {
  platform: string;
  url: string;
}

export interface ClankerToken {
  contract_address: `0x${string}`;
  name: string;
  symbol: string;
  chain_id?: number;
  pair?: string;
  pool_address?: `0x${string}`;
  factory_address?: `0x${string}`;
  locker_address?: `0x${string}`;
  tx_hash?: `0x${string}`;
  created_at?: string;
  metadata?: {
    socialMediaUrls?: ClankerSocial[];
    auditUrls?: string[];
  };
  type?: string;
  related?: {
    user?: {
      fid?: number;
      username?: string;
    };
    market?: any;
  };
}

type ClankerResponse = {
  data: ClankerToken[];
  total: number;
  cursor?: string;
};

export const listClankerTokens = async (
  params: Record<string, string | number | boolean> = {},
): Promise<ClankerResponse> => {
  const url = new URL(CLANKER_API);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });

  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Clanker HTTP ${res.status}`);
      }
      return (await res.json()) as ClankerResponse;
    },
    {
      maxRetries: 3,
      initialDelayMs: 500,
      onRetry: (err, attempt) => {
        console.warn(`[clanker] API retry ${attempt}/3:`, err instanceof Error ? err.message : err);
      },
    }
  );
};

const normalizeCommunity = (token: ClankerToken) => {
  const socials = token.metadata?.socialMediaUrls ?? [];
  const websites = socials
    .filter((link) => link.platform?.toLowerCase() === "website")
    .map((link) => link.url);
  const twitter = socials.find(
    (link) => link.platform?.toLowerCase() === "twitter",
  )?.url;
  const telegram = socials.find(
    (link) => link.platform?.toLowerCase() === "telegram",
  )?.url;
  const discord = socials.find(
    (link) => link.platform?.toLowerCase() === "discord",
  )?.url;
  return {
    websites,
    twitter,
    telegram,
    discord,
    raw: socials.map((link) => ({
      platform: link.platform,
      url: link.url,
    })),
  };
};

const fetchLaunchCountByFid = async (fid: number): Promise<number | undefined> => {
  const cached = launchCountCache.get(fid);
  if (cached !== undefined) {
    return cached;
  }

  const task = (async () => {
    try {
      const response = await listClankerTokens({
        fids: fid,
        limit: 1,
        includeUser: false,
        includeMarket: false,
        sort: "desc",
      });
      if (typeof response.total === "number") {
        return response.total;
      }
      return response.data.length;
    } catch (error) {
      console.warn(`[clanker] launch count lookup failed for fid ${fid}`, error instanceof Error ? error.message : error);
      return undefined;
    }
  })();

  launchCountCache.set(fid, task);
  return task;
};

export const buildClankerCandidate = async (
  token: ClankerToken,
): Promise<NewTokenCandidate> => {
  const fid = token.related?.user?.fid;
  const fcIdentity = fid ? await resolveFarcasterIdentity(fid) : undefined;
  const launchCount = fid ? await fetchLaunchCountByFid(fid) : undefined;

  const identity = {
    platform: "clanker" as const,
    creatorFid: fcIdentity?.creatorFid ?? fid,
    twitter: fcIdentity?.twitter,
    website: fcIdentity?.website,
    verifiedAddrs: fcIdentity?.verifiedAddrs,
    farcasterUsername:
      fcIdentity?.farcasterUsername ?? token.related?.user?.username,
    score: fcIdentity?.score,
    smartAccount: fcIdentity?.smartAccount,
    launchCount: fcIdentity?.launchCount ?? launchCount,
  };

  return {
    platform: "clanker",
    identity,
    token: {
      chainId: token.chain_id ?? 8453,
      address: token.contract_address,
      symbol: token.symbol,
      name: token.name,
      createdAt: token.created_at,
      poolAddress: token.pool_address,
      factory: token.factory_address,
      txHash: token.tx_hash,
    },
    schedule: {
      lpDeployedAt: token.created_at,
      source: "clanker",
    },
    community: normalizeCommunity(token),
    security: token.locker_address
      ? {
          lpLock: { locker: token.locker_address, percent: undefined },
        }
      : undefined,
  };
};

export const fetchRecentClankerCandidates = async (
  options: { limit?: number; withinMs?: number } = {},
) => {
  const limit = options.limit ?? 20;
  const withinMs = options.withinMs ?? ONE_DAY_MS;
  const response = await listClankerTokens({
    limit,
    sort: "desc",
    includeUser: true,
    includeMarket: false,
  });
  const now = Date.now();
  const recent = response.data.filter((token) => {
    if (!token.created_at) return true;
    const created = Date.parse(token.created_at);
    if (Number.isNaN(created)) return true;
    return now - created <= withinMs;
  });
  return Promise.all(recent.map((token) => buildClankerCandidate(token)));
};
