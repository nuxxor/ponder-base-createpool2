import { CommunityLinks } from "./types/community";
import { TokenMetricsSnapshot } from "./utils/watchlist";

const API_BASE = "https://api.dexscreener.com";

type WindowKey = "m5" | "h1" | "h6" | "h24";

type TxnStats = Record<WindowKey, { buys: number; sells: number }>;
type VolumeStats = Record<WindowKey, number>;
type PriceChangeStats = Record<WindowKey, number>;

export type DexTokenInfo = {
  address: string;
  name: string;
  symbol: string;
};

export type DexPair = {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  baseToken: DexTokenInfo;
  quoteToken: DexTokenInfo;
  priceNative?: string;
  priceUsd?: string;
  fdv?: number | null;
  marketCap?: number | null;
  labels?: string[];
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  txns?: Partial<TxnStats>;
  volume?: Partial<VolumeStats>;
  priceChange?: Partial<PriceChangeStats>;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { platform?: string; handle?: string }[];
  };
};

const parseNumber = (value?: number | string | null) => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const coerced = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(coerced) ? coerced : undefined;
};

const getWindowValue = (
  stats: Partial<Record<WindowKey, number>> | undefined,
  key: WindowKey,
): number => {
  const value = stats?.[key];
  return typeof value === "number" ? value : 0;
};

const getTxnCount = (
  txns: Partial<TxnStats> | undefined,
  key: WindowKey,
  field: "buys" | "sells",
): number => {
  const window = txns?.[key];
  if (!window) return 0;
  const value = window[field];
  return typeof value === "number" ? value : 0;
};

const normalizeUrl = (url?: string | null) => {
  if (!url) return null;
  let sanitized = url.trim();
  if (!sanitized) return null;
  if (!/^https?:\/\//i.test(sanitized)) {
    sanitized = `https://${sanitized.replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(sanitized);
    return parsed.href;
  } catch {
    return null;
  }
};

const buildSocialUrl = (platform: string, handle?: string | null) => {
  if (!handle) return null;
  let sanitized = handle.trim();
  if (!sanitized) return null;

  if (/^https?:\/\//i.test(sanitized)) {
    return sanitized;
  }

  sanitized = sanitized.replace(/^@/, "");
  const lowerPlatform = platform.toLowerCase();

  switch (lowerPlatform) {
    case "twitter":
    case "x":
      return `https://twitter.com/${sanitized}`;
    case "telegram":
      sanitized = sanitized.replace(/^t\.me\//i, "");
      return `https://t.me/${sanitized}`;
    case "discord":
      sanitized = sanitized.replace(/^discord\.gg\//i, "");
      sanitized = sanitized.replace(/^discord\.com\/invite\//i, "");
      return `https://discord.gg/${sanitized}`;
    case "github":
      sanitized = sanitized.replace(/^github\.com\//i, "");
      return `https://github.com/${sanitized}`;
    default:
      return null;
  }
};

const collectCommunityLinks = (pairs: DexPair[]): CommunityLinks | undefined => {
  const websiteCounts = new Map<string, number>();
  const uniqueWebsites = new Set<string>();
  const socialMap = new Map<string, { platform: string; url: string; handle?: string }>();

  for (const pair of pairs) {
    pair.info?.websites?.forEach((site) => {
      const normalized = normalizeUrl(site?.url);
      if (!normalized) return;
      uniqueWebsites.add(normalized);
      websiteCounts.set(normalized, (websiteCounts.get(normalized) ?? 0) + 1);
    });

    pair.info?.socials?.forEach((social) => {
      const platform = (social.platform ?? "").toLowerCase();
      if (!platform) return;
      const url = buildSocialUrl(platform, social.handle) ?? normalizeUrl(social.handle);
      if (!url) return;
      if (!socialMap.has(platform)) {
        socialMap.set(platform, { platform, url, handle: social.handle ?? undefined });
      }
    });
  }

  if (uniqueWebsites.size === 0 && socialMap.size === 0) {
    return undefined;
  }

  let primaryWebsite: string | undefined;
  if (websiteCounts.size > 0) {
    const sorted = [...websiteCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    );
    primaryWebsite = sorted[0]?.[0];
  }
  if (!primaryWebsite && uniqueWebsites.size > 0) {
    primaryWebsite = uniqueWebsites.values().next().value;
  }

  const community: CommunityLinks = {
    primaryWebsite,
  };

  if (uniqueWebsites.size > 0) {
    community.websites = [...uniqueWebsites];
  }

  if (socialMap.size > 0) {
    const socialsArray = [...socialMap.values()];
    community.socials = socialsArray;
    const twitterLink = socialMap.get("twitter") ?? socialMap.get("x");
    if (twitterLink) community.twitter = twitterLink.url;
    const telegramLink = socialMap.get("telegram");
    if (telegramLink) community.telegram = telegramLink.url;
    const discordLink = socialMap.get("discord");
    if (discordLink) community.discord = discordLink.url;
  }

  return community;
};

export const fetchPairsForToken = async (
  tokenAddress: string,
): Promise<DexPair[]> => {
  const url = `${API_BASE}/token-pairs/v1/base/${tokenAddress}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "base-createpool-monitor/1.0",
    },
  });

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    throw new Error(
      `Dexscreener request failed (${response.status} ${response.statusText})`,
    );
  }

  const data = (await response.json()) as DexPair[] | { pairs: DexPair[] };

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray((data as { pairs?: DexPair[] }).pairs)) {
    return (data as { pairs: DexPair[] }).pairs;
  }

  return [];
};

/**
 * Filter out suspicious/fake pairs
 * - Zero liquidity pairs
 * - Pairs with no trading activity
 * - Pairs created less than 5 minutes ago (bot activity)
 */
const filterValidPairs = (pairs: DexPair[]): DexPair[] => {
  const now = Date.now();
  const MIN_PAIR_AGE_MS = 5 * 60 * 1000; // 5 minutes
  const MIN_LIQUIDITY_USD = 100; // At least $100 liquidity

  return pairs.filter((pair) => {
    // Must have some liquidity
    const liquidity = parseNumber(pair.liquidity?.usd) ?? 0;
    if (liquidity < MIN_LIQUIDITY_USD) {
      return false;
    }

    // Filter out very new pairs (likely bot activity)
    if (pair.pairCreatedAt) {
      const pairAge = now - pair.pairCreatedAt;
      if (pairAge < MIN_PAIR_AGE_MS) {
        return false;
      }
    }

    // Must have SOME trading activity in 24h (at least 1 transaction)
    const buysH24 = getTxnCount(pair.txns, "h24", "buys");
    const sellsH24 = getTxnCount(pair.txns, "h24", "sells");
    if (buysH24 + sellsH24 === 0) {
      // Allow pairs without txn data (might just be missing)
      // but only if they have volume
      const volumeH24 = getWindowValue(pair.volume ?? {}, "h24");
      if (volumeH24 === 0) {
        return false;
      }
    }

    return true;
  });
};

export const aggregateTokenMetrics = (
  token: string,
  pairs: DexPair[],
): TokenMetricsSnapshot => {
  // Filter out suspicious pairs before aggregating
  const validPairs = filterValidPairs(pairs);
  // If all pairs were filtered, fall back to original pairs to avoid missing data
  const pairsToUse = validPairs.length > 0 ? validPairs : pairs;
  let totalLiquidityUsd = 0;
  let totalVolumeH1 = 0;
  let totalVolumeH24 = 0;
  let totalBuysH1 = 0;
  let totalSellsH1 = 0;
  let totalBuysH24 = 0;
  let totalSellsH24 = 0;

  let weightedPriceNumerator = 0;
  let weightedPriceDenominator = 0;

  let bestPair: DexPair | undefined;
  let bestPairLiquidity = 0;

  for (const pair of pairsToUse) {
    const liquidityUsd = parseNumber(pair.liquidity?.usd) ?? 0;
    totalLiquidityUsd += liquidityUsd;

    const h1Volume = getWindowValue(pair.volume ?? {}, "h1");
    const h24Volume = getWindowValue(pair.volume ?? {}, "h24");
    totalVolumeH1 += h1Volume;
    totalVolumeH24 += h24Volume;

    totalBuysH1 += getTxnCount(pair.txns, "h1", "buys");
    totalSellsH1 += getTxnCount(pair.txns, "h1", "sells");
    totalBuysH24 += getTxnCount(pair.txns, "h24", "buys");
    totalSellsH24 += getTxnCount(pair.txns, "h24", "sells");

    const priceUsd = parseNumber(pair.priceUsd);
    if (priceUsd && liquidityUsd > 0) {
      weightedPriceNumerator += priceUsd * liquidityUsd;
      weightedPriceDenominator += liquidityUsd;
    }

    if (liquidityUsd > bestPairLiquidity) {
      bestPairLiquidity = liquidityUsd;
      bestPair = pair;
    }
  }

  const buySellRatioH1 =
    totalSellsH1 === 0 ? totalBuysH1 : totalBuysH1 / totalSellsH1;
  const buySellRatioH24 =
    totalSellsH24 === 0 ? totalBuysH24 : totalBuysH24 / totalSellsH24;

  const priceUsd =
    weightedPriceDenominator > 0
      ? weightedPriceNumerator / weightedPriceDenominator
      : parseNumber(bestPair?.priceUsd);

  const community = collectCommunityLinks(pairs);

  const metrics: TokenMetricsSnapshot = {
    token,
    collectedAt: new Date().toISOString(),
    totalLiquidityUsd,
    totalVolumeH1,
    totalVolumeH24,
    totalBuysH1,
    totalSellsH1,
    totalBuysH24,
    totalSellsH24,
    buySellRatioH1: Number(buySellRatioH1.toFixed(3)),
    buySellRatioH24: Number(buySellRatioH24.toFixed(3)),
    priceUsd,
    priceChangeH1: parseNumber(bestPair?.priceChange?.h1),
    priceChangeH24: parseNumber(bestPair?.priceChange?.h24),
    bestPair: bestPair
      ? {
          pairAddress: bestPair.pairAddress,
          dexId: bestPair.dexId,
          url: bestPair.url,
          liquidityUsd: parseNumber(bestPair.liquidity?.usd),
          marketCap: bestPair.marketCap ?? null,
          fdv: bestPair.fdv ?? null,
          labels: bestPair.labels ?? [],
        }
      : undefined,
    community,
  };

  return metrics;
};
