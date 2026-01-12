import "./env";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DROP_LIQUIDITY_THRESHOLD_USD,
  DROP_PRICE_CHANGE_THRESHOLD,
  MIN_BUYS_PER_HOUR,
  MIN_BUY_SELL_RATIO,
  MIN_HEALTHY_LIQUIDITY_USD,
  PROMISING_SCORE_THRESHOLD,
  MIN_VOLUME_H1_USD,
  MAX_MARKETCAP_LIQUIDITY_RATIO,
  LIQUIDITY_DROP_PERCENT,
  LIQUIDITY_DROP_MIN_BASE,
  SUSPICIOUS_LABELS,
  MIN_CONSECUTIVE_HEALTHY_CYCLES,
  SECURITY_REFRESH_INTERVAL_MS,
  MAX_SECURITY_CHECKS_PER_CYCLE,
  MIN_LOCKED_LP_PERCENT,
} from "./constants";
import { aggregateTokenMetrics, fetchPairsForToken } from "./dexscreener";
import {
  EvaluationResult,
  SnapshotRecord,
  TokenMetricsSnapshot,
  appendSnapshotRecord,
  SecurityReport,
  readWatchlist,
  WatchEntry,
  updateWatchlist,
  mergeCommunityLinks,
} from "./utils/watchlist";
import {
  removePromisingToken,
  upsertPromisingToken,
} from "./utils/promising";
import { analyzeLpLockV2, fetchOwnerAddress } from "./basescan";
import { normalizeAddress } from "./utils/address";
import { refreshExternalSources } from "./pipelines/launchpads";
import { enforcePromisingSocialGate } from "./utils/socialProof";
import { sendTelegramAlert, TokenAlert } from "./services/telegram";

// Sent alerts cache to avoid duplicate notifications (bounded via TTL)
const SENT_ALERT_TTL_MS = Number(
  process.env.SENT_ALERT_TTL_MS ?? 7 * 24 * 60 * 60 * 1000,
);
const sentAlerts = new Map<string, number>();

const hasRecentlySentAlert = (token: string) => {
  const sentAt = sentAlerts.get(token);
  if (!sentAt) return false;
  return Date.now() - sentAt <= SENT_ALERT_TTL_MS;
};

const markSentAlert = (token: string) => {
  sentAlerts.set(token, Date.now());
};

const pruneSentAlerts = () => {
  if (sentAlerts.size === 0) return;
  const now = Date.now();
  for (const [token, sentAt] of sentAlerts) {
    if (now - sentAt > SENT_ALERT_TTL_MS) {
      sentAlerts.delete(token);
    }
  }
};

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const REQUEST_DELAY_MS = Number(
  process.env.DEXSCREENER_REQUEST_DELAY_MS ?? 500, // Reduced from 1200ms for faster detection
);
const RENOUNCED_ADDRESSES = new Set(
  [
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    "0x000000000000000000000000000000000000dEaD",
  ].map((a) => a.toLowerCase()),
);
const V2_PROTOCOLS = new Set(["uniswap_v2", "aerodrome_v2"]);

const createEmptyMetrics = (token: string): TokenMetricsSnapshot => ({
  token,
  collectedAt: new Date().toISOString(),
  totalLiquidityUsd: 0,
  totalVolumeH1: 0,
  totalVolumeH24: 0,
  totalBuysH1: 0,
  totalSellsH1: 0,
  totalBuysH24: 0,
  totalSellsH24: 0,
  buySellRatioH1: 0,
  buySellRatioH24: 0,
});

const suspiciousLabelSet = new Set(
  SUSPICIOUS_LABELS.map((label) => label.toLowerCase()),
);

const needsSecurityRefresh = (entry: WatchEntry) => {
  if (!entry.security) return true;
  const timestamps = [
    entry.security.owner?.checkedAt,
    entry.security.lp?.checkedAt,
  ]
    .filter(Boolean)
    .map((ts) => new Date(ts!).getTime());
  if (timestamps.length === 0) return true;
  const lastCheck = Math.min(...timestamps);
  return Date.now() - lastCheck > SECURITY_REFRESH_INTERVAL_MS;
};

const refreshSecurityReport = async (
  entry: WatchEntry,
): Promise<SecurityReport | null> => {
  try {
    const now = new Date().toISOString();
    const ownerAddress = await fetchOwnerAddress(entry.token);
    const ownerRenounced =
      ownerAddress !== null &&
      RENOUNCED_ADDRESSES.has(ownerAddress.toLowerCase());

    const security: SecurityReport = {
      owner: {
        address: ownerAddress,
        renounced: ownerRenounced,
        checkedAt: now,
      },
      riskFlags: [],
    };

    const primaryPool =
      entry.pools.find((pool) => V2_PROTOCOLS.has(pool.protocol)) ??
      entry.pools[0];

    if (primaryPool) {
      if (V2_PROTOCOLS.has(primaryPool.protocol)) {
        const lpReport = await analyzeLpLockV2(primaryPool.poolAddress);
        security.lp = {
          type: "v2",
          poolAddress: normalizeAddress(primaryPool.poolAddress),
          lockedPercent: lpReport?.lockedPercent,
          lockerBreakdown: lpReport?.lockerBreakdown ?? [],
          checkedAt: now,
        };
        if (
          lpReport?.lockedPercent !== undefined &&
          lpReport.lockedPercent < MIN_LOCKED_LP_PERCENT
        ) {
          security.riskFlags?.push("lp_unlocked");
        }
      } else if (
        primaryPool.protocol === "uniswap_v3" ||
        primaryPool.protocol === "aerodrome_slipstream"
      ) {
        security.lp = {
          type: "v3",
          poolAddress: normalizeAddress(primaryPool.poolAddress),
          checkedAt: now,
        };
      } else {
        security.lp = {
          type: "unknown",
          poolAddress: normalizeAddress(primaryPool.poolAddress),
          checkedAt: now,
        };
      }
    }

    await updateWatchlist((watchlist) => {
      const target = watchlist.tokens[entry.token];
      if (!target) return;
      target.security = security;
      return watchlist;
    });

    entry.security = security;
    return security;
  } catch (error) {
    console.warn(`[monitor] Security refresh failed for ${entry.token}`, error);
    return null;
  }
};

type EvaluateOptions = {
  previousMetrics?: TokenMetricsSnapshot;
  security?: SecurityReport;
};

const evaluateMetrics = (
  metrics: TokenMetricsSnapshot,
  options: EvaluateOptions = {},
): EvaluationResult => {
  const liquidityScore =
    metrics.totalLiquidityUsd >= MIN_HEALTHY_LIQUIDITY_USD
      ? 3
      : metrics.totalLiquidityUsd >= MIN_HEALTHY_LIQUIDITY_USD / 2
        ? 1
        : 0;

  const flowScore =
    metrics.totalBuysH1 >= MIN_BUYS_PER_HOUR ? 2 : metrics.totalBuysH1 > 0 ? 1 : 0;

  const buyPressureScore =
    metrics.buySellRatioH1 >= MIN_BUY_SELL_RATIO
      ? 2
      : metrics.buySellRatioH1 >= 0.4
        ? 1
        : 0;

  const momentumScore =
    (metrics.priceChangeH1 ?? 0) > 0 ? 1 : (metrics.priceChangeH1 ?? 0) > -20 ? 0 : -1;

  const score = liquidityScore + flowScore + buyPressureScore + momentumScore;

  const dropReasons: string[] = [];
  const warnings: string[] = [];
  const riskFlags: string[] = [];

  if (metrics.totalLiquidityUsd < DROP_LIQUIDITY_THRESHOLD_USD) {
    dropReasons.push("liquidity under safety threshold");
  }

  if ((metrics.priceChangeH1 ?? 0) <= DROP_PRICE_CHANGE_THRESHOLD) {
    dropReasons.push("price crash detected");
  }

  if (metrics.totalBuysH24 + metrics.totalSellsH24 === 0) {
    dropReasons.push("no trades in last 24h");
  }

  if (
    options.previousMetrics &&
    options.previousMetrics.totalLiquidityUsd >= LIQUIDITY_DROP_MIN_BASE
  ) {
    const prev = options.previousMetrics.totalLiquidityUsd;
    if (
      prev > 0 &&
      metrics.totalLiquidityUsd <= prev * (1 - LIQUIDITY_DROP_PERCENT)
    ) {
      dropReasons.push("rapid liquidity exit");
    }
  }

  const marketCap =
    metrics.bestPair?.marketCap ?? metrics.bestPair?.fdv ?? undefined;
  if (marketCap && metrics.totalLiquidityUsd > 0) {
    const ratio = marketCap / metrics.totalLiquidityUsd;
    if (ratio > MAX_MARKETCAP_LIQUIDITY_RATIO) {
      dropReasons.push("mcap/liquidity ratio abnormally high");
    }
  }

  const labels = metrics.bestPair?.labels ?? [];
  const suspiciousLabel = labels.find((label) =>
    suspiciousLabelSet.has(label.toLowerCase()),
  );
  if (suspiciousLabel) {
    dropReasons.push(`dex label: ${suspiciousLabel}`);
    riskFlags.push("dex_label");
  }

  if (metrics.totalVolumeH1 < MIN_VOLUME_H1_USD) {
    warnings.push("low 1h volume");
  }

  if (options.security?.owner && !options.security.owner.renounced) {
    warnings.push("owner not renounced");
    if (!options.security.riskFlags) {
      options.security.riskFlags = [];
    }
    options.security.riskFlags.push("owner_active");
  }

  if (
    options.security?.lp?.lockedPercent !== undefined &&
    options.security.lp.lockedPercent < MIN_LOCKED_LP_PERCENT
  ) {
    warnings.push("LP unlocked");
    riskFlags.push("lp_unlocked");
  }

  if (options.security?.riskFlags) {
    for (const flag of options.security.riskFlags) {
      if (!riskFlags.includes(flag)) riskFlags.push(flag);
    }
  }

  if (dropReasons.length > 0) {
    return {
      action: "drop",
      score,
      reason: dropReasons.join("; "),
      warnings: warnings.length ? warnings : undefined,
      riskFlags: riskFlags.length ? riskFlags : undefined,
    };
  }

  const positiveNotes: string[] = [];
  if (liquidityScore >= 3) positiveNotes.push("liquidity healthy");
  if (flowScore >= 2) positiveNotes.push("buy flow sustained");
  if (buyPressureScore >= 2) positiveNotes.push("buyers dominate sells");

  return {
    action: "watch",
    score,
    notes: positiveNotes.length ? positiveNotes.join("; ") : undefined,
    warnings: warnings.length ? warnings : undefined,
    riskFlags: riskFlags.length ? riskFlags : undefined,
  };
};

const recordSnapshot = async (
  snapshot: SnapshotRecord,
  meta?: { consecutiveHealthyCycles?: number; lastLiquidityUsd?: number },
) => {
  await appendSnapshotRecord(snapshot);

  await updateWatchlist((watchlist) => {
    const entry = watchlist.tokens[snapshot.token];
    if (!entry) return;

    entry.lastSnapshotAt = snapshot.metrics.collectedAt;
    entry.lastMetrics = snapshot.metrics;
    entry.community = mergeCommunityLinks(
      entry.community,
      snapshot.metrics.community,
    );
    entry.consecutiveHealthyCycles = meta?.consecutiveHealthyCycles ?? 0;
    entry.lastLiquidityUsd =
      meta?.lastLiquidityUsd ?? snapshot.metrics.totalLiquidityUsd;

    if (snapshot.evaluation.action === "drop") {
      entry.status = "dropped";
      entry.droppedReason = snapshot.evaluation.reason ?? "auto drop";
    } else {
      entry.status = "active";
      entry.droppedReason = undefined;
    }

    const annotations = [
      snapshot.evaluation.notes,
      snapshot.evaluation.warnings?.join(", "),
    ]
      .filter(Boolean)
      .join(" | ");
    entry.notes = annotations || undefined;

    return watchlist;
  });
};

const runCycle = async () => {
  pruneSentAlerts();
  await refreshExternalSources();
  const watchlist = await readWatchlist();
  const activeEntries = Object.values(watchlist.tokens).filter(
    (entry) => entry.status === "active",
  );

  if (activeEntries.length === 0) {
    console.info("[monitor] No active tokens to monitor.");
    return;
  }

  console.info(
    `[monitor] Checking ${activeEntries.length} active tokens at ${new Date().toISOString()}`,
  );

  let securityChecks = 0;

  for (const entry of activeEntries) {
    if (
      securityChecks < MAX_SECURITY_CHECKS_PER_CYCLE &&
      needsSecurityRefresh(entry)
    ) {
      const refreshed = await refreshSecurityReport(entry);
      if (refreshed) {
        securityChecks += 1;
      }
    }

    let metrics: TokenMetricsSnapshot | undefined;
    let evaluation: EvaluationResult | undefined;

    try {
      const pairs = await fetchPairsForToken(entry.token);
      if (pairs.length === 0) {
        metrics = createEmptyMetrics(entry.token);
        evaluation = {
          action: "watch",
          score: -1,
          reason: "No Dexscreener pools yet",
        };
      } else {
        metrics = aggregateTokenMetrics(entry.token, pairs);
        evaluation = evaluateMetrics(metrics, {
          previousMetrics: entry.lastMetrics,
          security: entry.security,
        });
      }
    } catch (error) {
      console.error(
        `[monitor] Failed to fetch Dexscreener data for ${entry.token}`,
        error,
      );
      const failureMetrics = createEmptyMetrics(entry.token);
      evaluation = {
        action: "watch",
        score: -2,
        reason: "Dexscreener fetch failed",
      };
      await recordSnapshot(
        {
          token: entry.token,
          metrics: failureMetrics,
          evaluation,
        },
        {
          consecutiveHealthyCycles: 0,
          lastLiquidityUsd: failureMetrics.totalLiquidityUsd,
        },
      );
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    if (!metrics || !evaluation) {
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    const shouldIncrement =
      evaluation.action === "watch" &&
      evaluation.score >= PROMISING_SCORE_THRESHOLD;
    const nextHealthy = shouldIncrement
      ? (entry.consecutiveHealthyCycles ?? 0) + 1
      : 0;

    await recordSnapshot(
      { token: entry.token, metrics, evaluation },
      {
        consecutiveHealthyCycles: nextHealthy,
        lastLiquidityUsd: metrics.totalLiquidityUsd,
      },
    );

    const qualifiesBase =
      shouldIncrement && nextHealthy >= MIN_CONSECUTIVE_HEALTHY_CYCLES;
    let qualifies = qualifiesBase;
    let socialReasons: string[] = [];
    if (qualifies) {
      try {
        const gate = await enforcePromisingSocialGate(entry);
        if (!gate.passes) {
          qualifies = false;
          socialReasons = gate.reasons;
          console.info(
            `[monitor] ${entry.token} social gate blocked: ${gate.reasons.join("; ") || "unknown reason"}`,
          );
        }
      } catch (error) {
        qualifies = false;
        socialReasons = [(error as Error).message];
        console.warn(
          `[monitor] Social gate error for ${entry.token}: ${(error as Error).message}`,
        );
      }
    }

    if (qualifies) {
      await upsertPromisingToken(entry.token, metrics, evaluation);

      // Send Telegram notification if not already sent
      if (!hasRecentlySentAlert(entry.token)) {
        const alert: TokenAlert = {
          token: entry.token,
          symbol: entry.tokenMeta?.symbol,
          name: entry.tokenMeta?.name,
          platform: entry.identity?.platform,
          liquidity: metrics.totalLiquidityUsd,
          volume24h: metrics.totalVolumeH24,
          buysH1: metrics.totalBuysH1,
          sellsH1: metrics.totalSellsH1,
          priceChange: metrics.priceChangeH1,
          score: evaluation.score,
          twitterFollowers: entry.identity?.socialStats?.twitter?.followers ?? undefined,
          farcasterFollowers: entry.identity?.socialStats?.farcaster?.followers ?? undefined,
          poolAddress: entry.pools[0]?.poolAddress,
          creatorFid: entry.identity?.creatorFid,
        };

        const sent = await sendTelegramAlert(alert);
        if (sent) {
          markSentAlert(entry.token);
          console.info(`[monitor] Telegram alert sent for ${entry.token}`);
        }
      }
    } else {
      await removePromisingToken(entry.token);
      if (socialReasons.length > 0) {
        entry.notes = socialReasons.join("; ");
      }
    }

    console.info(
      `[monitor] ${entry.token} :: liquidity=$${metrics.totalLiquidityUsd.toFixed(0)} buys(h1)=${metrics.totalBuysH1} sells(h1)=${metrics.totalSellsH1} score=${evaluation.score} status=${evaluation.action} streak=${nextHealthy}`,
    );

    await sleep(REQUEST_DELAY_MS);
  }
};

const main = async () => {
  const pollInterval =
    Number(process.env.POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;

  console.info(
    `[monitor] Starting Dexscreener watcher (interval=${pollInterval / 1000}s)`,
  );

  while (true) {
    const startedAt = Date.now();
    await runCycle();
    const elapsed = Date.now() - startedAt;
    const waitTime = Math.max(pollInterval - elapsed, 0);
    console.info(
      `[monitor] Cycle complete in ${(elapsed / 1000).toFixed(
        1,
      )}s. Sleeping ${(waitTime / 1000).toFixed(1)}s.`,
    );
    await sleep(waitTime);
  }
};

main().catch((error) => {
  console.error("[monitor] Fatal error", error);
  process.exit(1);
});
