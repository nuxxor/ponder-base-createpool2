import "../env";

import { spawnSync } from "node:child_process";
import path from "node:path";

import { WatchEntry, updateWatchlist } from "./watchlist";
import {
  Identity,
  CreatorVerification,
  SmartFollowerReport,
  SocialStat,
} from "../types/newToken";

const MIN_TWITTER_FOLLOWERS = Number(
  process.env.PROMISING_TWITTER_MIN_FOLLOWERS ?? 5000,
);
const MIN_FARCASTER_FOLLOWERS = Number(
  process.env.PROMISING_FARCASTER_MIN_FOLLOWERS ?? 2000,
);
const SOCIAL_STATS_TTL_MS = Number(
  process.env.SOCIAL_STATS_TTL_MS ?? 6 * 60 * 60 * 1000,
);
const MIN_CREATOR_FOLLOWERS = Number(
  process.env.PROMISING_CREATOR_MIN_FOLLOWERS ?? 300,
);
const CREATOR_VERIFICATION_TTL_MS = Number(
  process.env.CREATOR_VERIFICATION_TTL_MS ?? SOCIAL_STATS_TTL_MS,
);
const SMART_AUTO_RUN =
  String(process.env.SMART_FOLLOWER_AUTO_RUN ?? "false").toLowerCase() ===
  "true";
const SMART_AUTO_REFRESH_MS = Number(
  process.env.SMART_FOLLOWER_AUTO_REFRESH_MS ?? 24 * 60 * 60 * 1000,
);

const TWITTER_API_BASE = (
  process.env.TWITTER_API_BASE ?? "https://api.twitterapi.io"
).replace(/\/$/, "");
const TWITTER_API_KEY = process.env.TWITTER_API_KEY;
const FARCASTER_USER_API_BASE =
  process.env.FARCASTER_USER_API_BASE ?? "https://api.farcaster.xyz";
const CLANKER_API_KEY = process.env.CLANKER_API_KEY;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const ZORA_API_KEY = process.env.ZORA_API_KEY;
const ZORA_API_BASE =
  process.env.ZORA_API_BASE ?? "https://api-sdk.zora.engineering/api";

const BASE_ROOT = path.resolve(process.cwd(), "..");
const SMART_SCRIPT_PATH = path.join(
  BASE_ROOT,
  "scripts",
  "countSmartFollowers.js",
);

export type SocialGateResult = {
  passes: boolean;
  reasons: string[];
  stats: {
    twitter?: SocialStat;
    farcaster?: SocialStat;
    creator?: CreatorVerification;
  };
};

const nowIso = () => new Date().toISOString();

const sanitizeHandle = (value?: string | null) => {
  if (!value) return null;
  let handle = value.trim();
  if (!handle) return null;
  if (handle.startsWith("@")) handle = handle.slice(1);
  if (/^[a-z0-9_]+$/i.test(handle)) return handle.toLowerCase();
  return null;
};

const parseTwitterHandleFromUrl = (value?: string | null) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !url.hostname.includes("twitter.com") &&
      !url.hostname.includes("x.com")
    ) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    if (segments[0] === "i" && segments[1] === "communities") {
      return null;
    }
    return sanitizeHandle(segments[0]);
  } catch {
    return null;
  }
};

const extractTwitterHandle = (entry: WatchEntry) => {
  const candidates: (string | null | undefined)[] = [
    entry.identity?.twitter,
    entry.community?.twitter,
  ];
  entry.community?.socials?.forEach((link) => {
    if (
      link.platform?.toLowerCase() === "twitter" ||
      link.platform?.toLowerCase() === "x"
    ) {
      candidates.push(link.handle ?? link.url);
    }
  });
  entry.community?.raw?.forEach((link) => {
    if (
      link.platform?.toLowerCase() === "twitter" ||
      link.platform?.toLowerCase() === "x" ||
      link.url?.includes("twitter.com") ||
      link.url?.includes("x.com")
    ) {
      candidates.push(link.handle ?? link.url);
    }
  });
  for (const candidate of candidates) {
    const handle =
      sanitizeHandle(candidate) ?? parseTwitterHandleFromUrl(candidate);
    if (handle) return handle.toLowerCase();
  }
  return null;
};

const getStatAge = (stat?: SocialStat) => {
  if (!stat?.lastCheckedAt) return Infinity;
  return Date.now() - new Date(stat.lastCheckedAt).getTime();
};

const getCreatorCheckAge = (check?: CreatorVerification) => {
  if (!check?.checkedAt) return Infinity;
  return Date.now() - new Date(check.checkedAt).getTime();
};

const mutateIdentity = async (
  entry: WatchEntry,
  mutator: (identity: Identity) => void,
) => {
  let snapshot: Identity | undefined;
  await updateWatchlist((watchlist) => {
    const target = watchlist.tokens[entry.token];
    if (!target) return;
    const identity =
      target.identity ??
      ({
        platform: entry.platform ?? "zora",
      } as Identity);
    mutator(identity);
    target.identity = identity;
    snapshot = structuredClone(identity);
    return watchlist;
  });
  if (snapshot) {
    entry.identity = structuredClone(snapshot);
  }
};

const fetchTwitterFollowers = async (handle: string) => {
  if (!TWITTER_API_KEY) {
    throw new Error("TWITTER_API_KEY is not configured");
  }
  const url = new URL("/twitter/user/info", TWITTER_API_BASE);
  url.searchParams.set("userName", handle);
  const res = await fetch(url, {
    headers: {
      "x-api-key": TWITTER_API_KEY,
    },
  });
  if (!res.ok) {
    throw new Error(`twitterapi.io HTTP ${res.status}`);
  }
  const json = (await res.json()) as any;
  const followers =
    Number(json?.data?.followers ?? json?.data?.followersCount) ?? null;
  if (!Number.isFinite(followers)) {
    throw new Error("twitterapi.io response missing follower count");
  }
  return followers as number;
};

const fetchFarcasterFollowers = async (fid: number) => {
  const url = new URL("/v2/user", FARCASTER_USER_API_BASE);
  url.searchParams.set("fid", String(fid));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Warpcast user API HTTP ${res.status}`);
  }
  const json = (await res.json()) as any;
  const count = Number(json?.result?.user?.followerCount);
  if (!Number.isFinite(count)) {
    throw new Error("Farcaster user response missing followerCount");
  }
  return count;
};

const refreshTwitterStat = async (
  entry: WatchEntry,
  handle: string,
): Promise<SocialStat | undefined> => {
  const current = entry.identity?.socialStats?.twitter;
  if (
    current &&
    current.handle?.toLowerCase() === handle.toLowerCase() &&
    getStatAge(current) < SOCIAL_STATS_TTL_MS
  ) {
    return current;
  }
  let followers: number | null = null;
  let error: string | undefined;
  try {
    followers = await fetchTwitterFollowers(handle);
  } catch (err) {
    error = (err as Error).message;
  }
  const stat: SocialStat = {
    provider: "twitter",
    handle,
    followers,
    lastCheckedAt: nowIso(),
    source: "twitterapi.io",
    error,
  };
  await mutateIdentity(entry, (identity) => {
    identity.socialStats = identity.socialStats ?? {};
    identity.socialStats.twitter = stat;
  });
  return stat;
};

const refreshFarcasterStat = async (
  entry: WatchEntry,
  fid: number,
): Promise<SocialStat | undefined> => {
  const current = entry.identity?.socialStats?.farcaster;
  if (
    current &&
    current.fid === fid &&
    getStatAge(current) < SOCIAL_STATS_TTL_MS
  ) {
    return current;
  }
  let followers: number | null = null;
  let error: string | undefined;
  try {
    followers = await fetchFarcasterFollowers(fid);
  } catch (err) {
    error = (err as Error).message;
  }
  const stat: SocialStat = {
    provider: "farcaster",
    handle: entry.identity?.farcasterUsername ?? String(fid),
    fid,
    followers,
    lastCheckedAt: nowIso(),
    source: "api.farcaster.xyz",
    error,
  };
  await mutateIdentity(entry, (identity) => {
    identity.socialStats = identity.socialStats ?? {};
    identity.socialStats.farcaster = stat;
  });
  return stat;
};

const fetchClankerCreator = async (token: string) => {
  if (!CLANKER_API_KEY) {
    throw new Error("CLANKER_API_KEY is not configured");
  }
  const url = new URL(
    "/api/get-clanker-by-address",
    "https://www.clanker.world",
  );
  url.searchParams.set("address", token);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Clanker HTTP ${res.status}`);
  }
  const json = (await res.json()) as any;
  const data = json?.data ?? {};
  return {
    requestorFid: data.requestor_fid as number | undefined,
    platform: data.social_context?.platform as string | undefined,
    msgSender: data.msg_sender as string | undefined,
  };
};

const fetchNeynarUser = async (fid: number) => {
  if (!NEYNAR_API_KEY) {
    throw new Error("NEYNAR_API_KEY is not configured");
  }
  const url = new URL("/user/bulk", "https://api.neynar.com/v2/farcaster");
  url.searchParams.set("fids", String(fid));
  const res = await fetch(url, {
    headers: { "x-api-key": NEYNAR_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`Neynar HTTP ${res.status}`);
  }
  const json = (await res.json()) as any;
  return (json?.users ?? [])[0];
};

const fetchZoraCreator = async (token: string) => {
  if (!ZORA_API_KEY) {
    throw new Error("ZORA_API_KEY is not configured");
  }
  const url = new URL("/coin", ZORA_API_BASE);
  url.searchParams.set("address", token);
  url.searchParams.set("chain", "8453");
  const res = await fetch(url, {
    headers: { "api-key": ZORA_API_KEY, Accept: "application/json" },
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Zora HTTP ${res.status}`);
  }
  const json = (await res.json()) as any;
  const farcaster =
    json?.data?.zora20Token?.creatorProfile?.socialAccounts?.farcaster;
  return {
    fid: farcaster?.id ?? farcaster?.fid ?? null,
    handle: farcaster?.username ?? null,
    followers: farcaster?.followerCount ?? null,
    creatorVisible: Boolean(farcaster?.username || farcaster?.id),
  };
};

export const refreshCreatorVerification = async (
  entry: WatchEntry,
): Promise<CreatorVerification | undefined> => {
  const cached = entry.identity?.creatorVerification;
  if (cached && getCreatorCheckAge(cached) < CREATOR_VERIFICATION_TTL_MS) {
    return cached;
  }

  const reasons: string[] = [];
  const token = entry.token;
  let clankerData:
    | { requestorFid?: number; platform?: string; msgSender?: string }
    | undefined;
  let neynarUser: any;
  let zoraData:
    | { fid?: number | string | null; handle?: string | null; followers?: number | null; creatorVisible?: boolean }
    | undefined;

  // Clanker (if key present)
  if (CLANKER_API_KEY) {
    try {
      clankerData = await fetchClankerCreator(token);
    } catch (error) {
      reasons.push((error as Error).message);
    }
  }

  // Zora (works without Clanker)
  try {
    zoraData = await fetchZoraCreator(token) ?? undefined;
  } catch (error) {
    reasons.push((error as Error).message);
  }

  // Neynar (prefer clanker fid, fallback to zora fid)
  const neynarFid =
    clankerData?.requestorFid ??
    (zoraData?.fid ? Number(zoraData.fid) : undefined);
  if (neynarFid && NEYNAR_API_KEY) {
    try {
      neynarUser = await fetchNeynarUser(neynarFid);
    } catch (error) {
      reasons.push((error as Error).message);
    }
  }

  const followerCount = neynarUser?.follower_count as number | undefined;
  const verifiedEth: string[] =
    neynarUser?.verified_addresses?.eth_addresses ?? [];
  const handle = neynarUser?.username as string | undefined;
  const creatorLinked =
    clankerData?.msgSender &&
    verifiedEth.some(
      (addr) =>
        addr?.toLowerCase() === clankerData!.msgSender?.toLowerCase(),
    );

  const followerSource =
    typeof followerCount === "number"
      ? followerCount
      : (zoraData?.followers as number | null | undefined);

  const condFollowers =
    typeof followerSource === "number" &&
    followerSource >= MIN_CREATOR_FOLLOWERS;
  const condClanker =
    clankerData?.requestorFid !== undefined &&
    clankerData.requestorFid !== null &&
    clankerData.platform === "Farcaster";
  const condZoraVisible = zoraData?.creatorVisible ?? false;
  const condFidMatch =
    clankerData?.requestorFid && zoraData?.fid
      ? String(zoraData.fid) === String(clankerData?.requestorFid ?? "")
      : true;
  const condLinked = creatorLinked === true;

  const branchClanker =
    condClanker && condFollowers && condLinked && condFidMatch;
  const branchZora = condZoraVisible && condFollowers;
  const passes = branchClanker || branchZora;

  if (!condFollowers) {
    reasons.push(
      `Farcaster followers ${followerSource ?? "unknown"} < ${MIN_CREATOR_FOLLOWERS}`,
    );
  }
  if (!condZoraVisible) reasons.push("Zora creator missing");
  if (!condFidMatch)
    reasons.push(
      `Creator FID mismatch (Clanker ${clankerData?.requestorFid} vs Zora ${zoraData?.fid})`,
    );
  if (condClanker && !condLinked)
    reasons.push("msg_sender not verified for creator");

  const snapshot: CreatorVerification = {
    passes,
    checkedAt: nowIso(),
    reasons: reasons.length ? reasons : ["OK"],
    fid: clankerData?.requestorFid,
    handle,
    farcasterFollowers: followerCount ?? null,
    msgSender: clankerData?.msgSender ?? null,
    msgSenderVerified: condLinked,
    zora: zoraData,
    sources: {
      clanker: {
        platform: clankerData?.platform,
        requestorFid: clankerData?.requestorFid ?? null,
        msgSender: clankerData?.msgSender ?? null,
      },
    },
  };

  await mutateIdentity(entry, (identity) => {
    identity.creatorVerification = snapshot;
  });

  return snapshot;
};

const shouldRunSmartFollowerAudit = (entry: WatchEntry) => {
  if (!SMART_AUTO_RUN) return false;
  const lastRunAt = entry.identity?.smartFollowers?.lastCheckedAt;
  if (!lastRunAt) return true;
  return Date.now() - new Date(lastRunAt).getTime() > SMART_AUTO_REFRESH_MS;
};

const runSmartFollowerAudit = async (
  entry: WatchEntry,
  handle: string,
): Promise<SmartFollowerReport | null> => {
  if (!shouldRunSmartFollowerAudit(entry)) {
    return entry.identity?.smartFollowers ?? null;
  }
  const result = spawnSync("node", [SMART_SCRIPT_PATH, "--handle", handle, "--json"], {
    cwd: BASE_ROOT,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    console.warn(
      `[smart-followers] Moni fetch failed for @${handle}: ${result.stderr || result.stdout}`,
    );
    return null;
  }
  let payload: any;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    console.warn(
      `[smart-followers] Unable to parse JSON for @${handle}: ${(error as Error).message}`,
    );
    return null;
  }
  const social = payload?.social ?? payload?.moni ?? {};
  const topSample = Array.isArray(payload?.topSmarts)
    ? payload.topSmarts.slice(0, 5)
    : undefined;
  const report: SmartFollowerReport = {
    provider: "moni",
    handle,
    lastCheckedAt: nowIso(),
    totalSmarts: social?.smarts ?? social?.totalSmarts,
    moniScore: social?.moniScore ?? social?.score,
    followers: social?.followers,
    topSample,
  };
  await mutateIdentity(entry, (identity) => {
    identity.smartFollowers = report;
  });
  return report;
};

export const enforcePromisingSocialGate = async (
  entry: WatchEntry,
): Promise<SocialGateResult> => {
  const reasons: string[] = [];
  const twitterHandle = extractTwitterHandle(entry);
  if (!twitterHandle) {
    return {
      passes: false,
      reasons: ["Twitter handle missing"],
      stats: {},
    };
  }
  const twitterStat = await refreshTwitterStat(entry, twitterHandle);
  const farcasterFid = entry.identity?.creatorFid;
  const farcasterStat = farcasterFid
    ? await refreshFarcasterStat(entry, farcasterFid)
    : undefined;

  let passes = true;

  if (!twitterStat?.followers || twitterStat.followers < MIN_TWITTER_FOLLOWERS) {
    passes = false;
    const followerText =
      twitterStat?.followers !== null && twitterStat?.followers !== undefined
        ? twitterStat.followers
        : "unknown";
    reasons.push(
      `Twitter followers ${followerText} < ${MIN_TWITTER_FOLLOWERS}`,
    );
  }
  if (twitterStat?.error) {
    reasons.push(`Twitter fetch error: ${twitterStat.error}`);
  }

  if (farcasterFid) {
    if (
      !farcasterStat?.followers ||
      farcasterStat.followers < MIN_FARCASTER_FOLLOWERS
    ) {
      passes = false;
      const followerText =
        farcasterStat?.followers !== null &&
        farcasterStat?.followers !== undefined
          ? farcasterStat.followers
          : "unknown";
      reasons.push(
        `Farcaster followers ${followerText} < ${MIN_FARCASTER_FOLLOWERS}`,
      );
    }
    if (farcasterStat?.error) {
      reasons.push(`Farcaster fetch error: ${farcasterStat.error}`);
    }
  }

  let creatorCheck: CreatorVerification | undefined;
  if (passes) {
    try {
      creatorCheck = await refreshCreatorVerification(entry);
      if (!creatorCheck?.passes) {
        passes = false;
        if (creatorCheck?.reasons?.length) {
          reasons.push(...creatorCheck.reasons);
        } else {
          reasons.push("Creator verification failed");
        }
      }
    } catch (error) {
      passes = false;
      reasons.push(`Creator verification error: ${(error as Error).message}`);
    }
  }

  if (passes && twitterHandle) {
    await runSmartFollowerAudit(entry, twitterHandle);
  }

  return {
    passes,
    reasons,
    stats: {
      twitter: twitterStat,
      farcaster: farcasterStat,
      creator: creatorCheck,
    },
  };
};
