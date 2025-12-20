import "../env";

import { NewTokenCandidate } from "../types/newToken";
import { findSmartFollower } from "../utils/smartFollowers";

const ZORA_API = "https://api-sdk.zora.engineering";
const ZORA_API_KEY = process.env.ZORA_API_KEY;
const ZORA_EXPLORE_COUNT = Number(process.env.ZORA_EXPLORE_COUNT ?? 200);

type ExploreEdge = {
  node: {
    address?: `0x${string}`;
    chain?: number;
    symbol?: string;
    name?: string;
    createdAt?: string;
    token?: {
      address?: `0x${string}`;
      chainId?: number;
      symbol?: string;
      name?: string;
      createdAt?: string;
    };
  };
};

const request = async (path: string, params: Record<string, string>) => {
  if (!ZORA_API_KEY) {
    throw new Error("Missing ZORA_API_KEY");
  }
  const url = new URL(path, ZORA_API);
  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value),
  );
  const res = await fetch(url, {
    headers: {
      "api-key": ZORA_API_KEY,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Zora HTTP ${res.status}`);
  }
  return res.json();
};

export const fetchZoraExploreNew = async (count = ZORA_EXPLORE_COUNT) => {
  const json = (await request("/explore", {
    listType: "NEW",
    count: String(count),
  })) as any;
  const payload = json?.data ?? json;
  const edges: ExploreEdge[] = payload?.exploreList?.edges ?? [];
  return edges.map((edge) => edge.node).filter(Boolean);
};

const normalizeTwitterHandle = (value?: string) => {
  if (!value) return undefined;
  let handle = value.trim();
  if (!handle) return undefined;
  if (handle.startsWith("http")) {
    try {
      const url = new URL(handle);
      if (url.hostname.includes("twitter") || url.hostname.includes("x.com")) {
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length > 0) {
          handle = segments[0]!;
        }
      }
    } catch {
      return undefined;
    }
  }
  if (handle.startsWith("@")) {
    handle = handle.slice(1);
  }
  return handle?.toLowerCase() ?? undefined;
};

const extractTwitterFromProfile = (payload: any): string | undefined => {
  if (!payload) return undefined;
  const candidates = [
    payload?.twitter,
    payload?.twitterUsername,
    payload?.twitterHandle,
    payload?.profile?.twitter,
    payload?.user?.twitter,
    payload?.user?.twitterHandle,
    payload?.links?.twitter,
    payload?.links?.twitter?.handle,
    payload?.identity?.twitter?.username,
    payload?.primaryProfile?.twitter?.username,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTwitterHandle(candidate);
    if (normalized) return normalized;
  }

  const linkCollections = [
    payload?.links,
    payload?.socialLinks,
    payload?.profile?.socialLinks,
    payload?.profile?.links,
    payload?.user?.links,
  ].filter(Boolean);

  for (const collection of linkCollections) {
    if (!Array.isArray(collection)) continue;
    for (const link of collection) {
      if (!link) continue;
      const type = String(link.type ?? link.platform ?? link.provider ?? "").toLowerCase();
      if (type.includes("twitter") || type === "x") {
        const normalized =
          normalizeTwitterHandle(link.handle ?? link.username) ??
          normalizeTwitterHandle(link.url);
        if (normalized) return normalized;
      }
    }
  }

  if (typeof payload === "string") {
    return normalizeTwitterHandle(payload);
  }

  return undefined;
};

const fetchZoraProfileTwitter = async (address: `0x${string}`) => {
  if (!ZORA_API_KEY) return undefined;
  try {
    const profile = (await request("/profile", {
      identifier: address,
    })) as any;
    const payload = profile?.data ?? profile;
    const twitter =
      extractTwitterFromProfile(payload?.profile) ??
      extractTwitterFromProfile(payload);
    return twitter;
  } catch (error) {
    console.warn(`[zora] Failed to fetch profile for ${address}`, error);
    return undefined;
  }
};

export const buildZoraCandidates = async (
  count = ZORA_EXPLORE_COUNT,
): Promise<NewTokenCandidate[]> => {
  if (!ZORA_API_KEY) {
    console.warn(
      "[zora] Skipping poll because ZORA_API_KEY is not configured.",
    );
    return [];
  }
  const nodes = await fetchZoraExploreNew(count);
  const candidates: NewTokenCandidate[] = [];

  for (const node of nodes) {
    const address = (node.address ?? node.token?.address)?.toLowerCase();
    if (!address || !/^0x[a-f0-9]{40}$/.test(address)) continue;
    const twitterHandle = await fetchZoraProfileTwitter(address as `0x${string}`);
    const smartAccount = twitterHandle ? findSmartFollower(twitterHandle) : null;
    const twitter = twitterHandle ? `@${twitterHandle}` : undefined;

    candidates.push({
      platform: "zora",
      identity: {
        platform: "zora",
        twitter,
        smartAccount: smartAccount
          ? {
              handle: smartAccount.handle,
              url: smartAccount.twitter_url,
              source: "smart_followers_master",
            }
          : undefined,
      },
      token: {
        chainId: node.chain ?? node.token?.chainId ?? 8453,
        address: address as `0x${string}`,
        symbol: node.symbol ?? node.token?.symbol,
        name: node.name ?? node.token?.name,
        createdAt: node.createdAt ?? node.token?.createdAt,
      },
      community: twitterHandle
        ? {
            twitter: `https://twitter.com/${twitterHandle}`,
          }
        : undefined,
    });
  }

  return candidates;
};
