import "../env";

import { NEYNAR_SCORE_CACHE_TTL_MS } from "../constants";
import { LRUCache } from "../utils/lruCache";
import { withRetry } from "../utils/retry";

const API_BASE =
  (process.env.NEYNAR_API_BASE ?? "https://api.neynar.com").replace(/\/$/, "") +
  "/";
const API_KEY = process.env.NEYNAR_API_KEY;

type NeynarUser = {
  score?: number;
  experimental?: { neynar_user_score?: number };
  fid?: number;
  id?: number;
  follower_count?: number;
};

type CacheEntry = { score: number | null; followers?: number; fetchedAt: number };

// LRU cache with max 2000 entries and configurable TTL
const cache = new LRUCache<number, CacheEntry>(2000, NEYNAR_SCORE_CACHE_TTL_MS);

const readScore = (user: NeynarUser | undefined): number | null => {
  if (!user) return null;
  const primary = user.score;
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  const experimental = user.experimental?.neynar_user_score;
  if (typeof experimental === "number" && Number.isFinite(experimental)) {
    return experimental;
  }
  return null;
};

export const getNeynarScoreByFid = async (
  fid: number,
): Promise<number | null> => {
  if (!API_KEY) {
    throw new Error("NEYNAR_API_KEY is not configured");
  }

  const cached = cache.get(fid);
  if (cached) {
    return cached.score;
  }

  const url = new URL("v2/farcaster/user/bulk", API_BASE);
  url.searchParams.set("fids", String(fid));

  try {
    const json = await withRetry(
      async () => {
        const res = await fetch(url, {
          headers: {
            "x-api-key": API_KEY,
            Accept: "application/json",
          },
        });

        if (!res.ok) {
          throw new Error(`Neynar HTTP ${res.status}`);
        }

        return (await res.json()) as { users?: NeynarUser[] };
      },
      {
        maxRetries: 3,
        initialDelayMs: 500,
        onRetry: (err, attempt) => {
          console.warn(`[neynar] Score lookup retry ${attempt}/3 for FID ${fid}:`, err instanceof Error ? err.message : err);
        },
      }
    );

    const user = json?.users?.[0];
    const score = readScore(user);
    const followers = user?.follower_count;

    cache.set(fid, { score, followers, fetchedAt: Date.now() });
    return score;
  } catch (error) {
    console.error(`[neynar] Failed to fetch score for FID ${fid}:`, error instanceof Error ? error.message : error);
    return null;
  }
};

export const getNeynarUserByFid = async (
  fid: number,
): Promise<{ score: number | null; followers?: number } | null> => {
  if (!API_KEY) {
    return null;
  }

  const cached = cache.get(fid);
  if (cached) {
    return { score: cached.score, followers: cached.followers };
  }

  const url = new URL("v2/farcaster/user/bulk", API_BASE);
  url.searchParams.set("fids", String(fid));

  try {
    const json = await withRetry(
      async () => {
        const res = await fetch(url, {
          headers: {
            "x-api-key": API_KEY,
            Accept: "application/json",
          },
        });

        if (!res.ok) {
          throw new Error(`Neynar HTTP ${res.status}`);
        }

        return (await res.json()) as { users?: NeynarUser[] };
      },
      {
        maxRetries: 3,
        initialDelayMs: 500,
      }
    );

    const user = json?.users?.[0];
    const score = readScore(user);
    const followers = user?.follower_count;

    cache.set(fid, { score, followers, fetchedAt: Date.now() });
    return { score, followers };
  } catch (error) {
    console.error(`[neynar] Failed to fetch user for FID ${fid}:`, error instanceof Error ? error.message : error);
    return null;
  }
};

const fetchUserByUsername = async (
  username: string,
): Promise<{ fid?: number; score: number | null } | null> => {
  if (!API_KEY) {
    throw new Error("NEYNAR_API_KEY is not configured");
  }
  const sanitized = username.replace(/^@/, "").trim().toLowerCase();
  if (!sanitized) return null;

  const variants = [
    `v2/farcaster/user/by_username?username=${encodeURIComponent(sanitized)}`,
    `v1/user/by_username?username=${encodeURIComponent(sanitized)}`,
  ];

  for (const path of variants) {
    const url = new URL(path, API_BASE);
    const res = await fetch(url, {
      headers: { "x-api-key": API_KEY, Accept: "application/json" },
    });
    if (!res.ok) {
      continue;
    }
    const json = (await res.json()) as any;
    const user = json?.user ?? json?.result?.user ?? json?.data ?? json;
    if (!user) continue;
    const score = readScore(user);
    const fid =
      typeof user.fid === "number"
        ? user.fid
        : typeof user.id === "number"
          ? user.id
          : undefined;
    return { fid, score };
  }
  return null;
};

const searchUser = async (
  query: string,
): Promise<{ fid?: number; score: number | null } | null> => {
  if (!API_KEY) {
    throw new Error("NEYNAR_API_KEY is not configured");
  }
  const sanitized = query.trim();
  if (!sanitized) return null;

  const url = new URL("v2/farcaster/user/search", API_BASE);
  url.searchParams.set("q", sanitized);
  url.searchParams.set("limit", "25");

  const res = await fetch(url, {
    headers: { "x-api-key": API_KEY, Accept: "application/json" },
  });

  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as any;
  const users: any[] =
    json?.result?.users ??
    json?.users ??
    [];
  if (!Array.isArray(users) || users.length === 0) return null;
  const lower = sanitized.toLowerCase();
  const exact =
    users.find(
      (u) =>
        typeof u.username === "string" &&
        u.username.toLowerCase() === lower,
    ) ?? users[0];
  const score = readScore(exact);
  const fid =
    typeof exact.fid === "number"
      ? exact.fid
      : typeof exact.id === "number"
        ? exact.id
        : undefined;
  return { fid, score };
};

const stripKnownSuffix = (value: string) => {
  const lower = value.toLowerCase();
  const suffixes = [".eth", ".base", ".lens", ".btc", ".sol"];
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) {
      return value.slice(0, -suffix.length);
    }
  }
  return value;
};

export const getNeynarScoreByUsername = async (
  username: string,
): Promise<{ fid?: number; score: number | null }> => {
  const attempts = [
    username,
    stripKnownSuffix(username),
  ].filter((v, idx, arr) => v && arr.indexOf(v) === idx);

  for (const candidate of attempts) {
    let result = await fetchUserByUsername(candidate);
    if (!result) {
      result = await searchUser(candidate);
    }
    if (!result) continue;
    if (result.score !== null && result.score !== undefined) {
      return result;
    }
    if (result.fid !== undefined) {
      const score = await getNeynarScoreByFid(result.fid);
      return { fid: result.fid, score };
    }
  }

  // last resort search original
  const fallback = await searchUser(username);
  if (fallback) {
    if (fallback.score !== null && fallback.score !== undefined) {
      return fallback;
    }
    if (fallback.fid !== undefined) {
      const score = await getNeynarScoreByFid(fallback.fid);
      return { fid: fallback.fid, score };
    }
  }

  return { fid: undefined, score: null };
};

export const clearNeynarScoreCache = () => cache.clear();
