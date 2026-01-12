import "../env";

import { Identity } from "../types/newToken";
import { LRUCache } from "../utils/lruCache";
import { findSmartFollower } from "../utils/smartFollowers";
import { guardedFetch } from "../utils/http";

const HUB_ORIGIN =
  process.env.FARCASTER_HUB_HTTP ?? "https://hub-api.neynar.com";
const HUB_HEADERS: Record<string, string> = {
  Accept: "application/json",
};

if (process.env.FARCASTER_API_KEY) {
  HUB_HEADERS["api-key"] = process.env.FARCASTER_API_KEY;
}

const userDataType = {
  USERNAME: "USER_DATA_TYPE_USERNAME",
  TWITTER: "USER_DATA_TYPE_TWITTER",
  URL: "USER_DATA_TYPE_URL",
};

const cache = new LRUCache<number, Promise<Identity>>(
  5000,
  Number(process.env.FARCASTER_IDENTITY_CACHE_TTL_MS ?? 6 * 60 * 60 * 1000),
);

const request = async (path: string, params: Record<string, string>) => {
  const url = new URL(`/v1/${path}`, HUB_ORIGIN);
  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value),
  );
  const res = await guardedFetch(
    url,
    { headers: HUB_HEADERS },
    {
      hostKey: new URL(HUB_ORIGIN).host,
      concurrency: Number(process.env.FARCASTER_HUB_CONCURRENCY ?? 4),
      timeoutMs: Number(process.env.FARCASTER_HUB_TIMEOUT_MS ?? 10_000),
      maxRetries: 2,
      initialDelayMs: 500,
    },
  );
  if (!res.ok) {
    throw new Error(`Farcaster hub HTTP ${res.status}`);
  }
  return (await res.json()) as any;
};

const fetchUserDataValue = async (fid: number, type: string) => {
  try {
    const json = (await request("userDataByFid", {
      fid: String(fid),
      user_data_type: type,
    })) as any;
    return json?.data?.userDataBody?.value as string | undefined;
  } catch {
    return undefined;
  }
};

const fetchVerifications = async (fid: number): Promise<`0x${string}`[]> => {
  try {
    const json = (await request("verificationsByFid", {
      fid: String(fid),
    })) as any;
    const addresses =
      json?.messages
        ?.map(
          (m: any) => m?.data?.verificationAddEthAddressBody?.address as
            | `0x${string}`
            | undefined,
        )
        ?.filter(Boolean) ?? [];
    return Array.from(
      new Set(
        addresses.map((addr: `0x${string}`) => addr.toLowerCase() as `0x${string}`),
      ),
    );
  } catch {
    return [];
  }
};

const computeScore = (identity: Identity): number => {
  let score = 0;
  if (identity.twitter) score += 5;
  if (identity.verifiedAddrs && identity.verifiedAddrs.length > 0) score += 3;
  if (identity.website) score += 2;
  if (identity.smartAccount) score += 4;
  return score;
};

export const resolveFarcasterIdentity = async (
  fid: number,
): Promise<Identity> => {
  const cached = cache.get(fid);
  if (cached) return cached;

  const task = (async (): Promise<Identity> => {
    const [twitter, username, website, verifiedAddrs] = await Promise.all([
      fetchUserDataValue(fid, userDataType.TWITTER),
      fetchUserDataValue(fid, userDataType.USERNAME),
      fetchUserDataValue(fid, userDataType.URL),
      fetchVerifications(fid),
    ]);

    const smartAccount = findSmartFollower(twitter);

    const identity: Identity = {
      platform: "farcaster",
      creatorFid: fid,
      twitter,
      farcasterUsername: username,
      website,
      verifiedAddrs,
      smartAccount: smartAccount
        ? {
            handle: smartAccount.handle,
            url: smartAccount.twitter_url,
            source: "smart_followers_master",
          }
        : undefined,
    };
    identity.score = computeScore(identity);
    return identity;
  })();

  cache.set(fid, task);
  task.catch(() => {
    cache.delete(fid);
  });
  return task;
};
