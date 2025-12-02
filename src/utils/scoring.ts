import {
  ClankerScoreInputs,
  FarcasterSignals,
  ScoreBlockBreakdown,
  ScoreResult,
  TwitterSignals,
  ZoraScoreInputs,
} from "../types/score";

const pickTier = (value: number | undefined, tiers: Array<{ max: number; points: number }>) => {
  if (value === undefined || value === null) return 0;
  for (const tier of tiers) {
    if (value <= tier.max) return tier.points;
  }
  return tiers.length > 0 ? tiers[tiers.length - 1]!.points : 0;
};

const normalize = (raw: number, max: number) => {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, raw / max));
};

const ethAllocationFromScore = (score: number) => {
  if (score < 40) return 0;
  if (score < 60) return 0.02;
  if (score < 80) return 0.05;
  if (score < 100) return 0.1;
  return 0.2;
};

const buildBlock = (
  name: string,
  raw: number,
  max: number,
  weight: number,
  parentWeight: number,
): ScoreBlockBreakdown => {
  const normalized = normalize(raw, max);
  const weighted = normalized * weight * parentWeight;
  return { name, raw, max, weight, normalized, weighted };
};

const computeFarcasterBlock = (signals: FarcasterSignals | undefined) => {
  const neynar = signals?.neynarScore;
  if (neynar !== undefined && neynar !== null) {
    const clamped = Math.max(0, Math.min(1, neynar));
    const block = buildBlock("fc_neynar_score", clamped, 1, 1, 1);
    const score = clamped * 50; // Farcaster block contributes up to 50 via Neynar score
    return { score, blocks: [block] };
  }

  const devLaunchCount = signals?.developerLaunchCount;
  const devRaw =
    devLaunchCount === undefined
      ? 0
      : devLaunchCount === 0
        ? 15
        : devLaunchCount <= 2
          ? 10
          : devLaunchCount === 3
            ? 0
            : 0;
  const farcasterDev = buildBlock("fc_dev_history", devRaw, 15, 0.1, 1);

  const ageDays = signals?.accountAgeDays ?? 0;
  const ageRaw = pickTier(ageDays, [
    { max: 7, points: 0 },
    { max: 21, points: 10 },
    { max: 45, points: 15 },
    { max: 90, points: 18 },
    { max: 180, points: 21 },
    { max: 360, points: 24 },
    { max: Number.POSITIVE_INFINITY, points: 30 },
  ]);
  const farcasterAge = buildBlock("fc_age", ageRaw, 30, 0.2, 1);

  const posts = signals?.postCount ?? 0;
  const postRaw = pickTier(posts, [
    { max: 1, points: 0 },
    { max: 5, points: 2 },
    { max: 10, points: 5 },
    { max: 20, points: 7 },
    { max: 30, points: 10 },
    { max: 50, points: 12 },
    { max: Number.POSITIVE_INFINITY, points: 15 },
  ]);
  const farcasterPosts = buildBlock("fc_posts", postRaw, 15, 0.1, 1);

  const followerRaw = pickTier(signals?.followerCount ?? 0, [
    { max: 50, points: 0 },
    { max: 200, points: 5 },
    { max: 600, points: 8 },
    { max: 1500, points: 12 },
    { max: 3000, points: 18 },
    { max: 7500, points: 22 },
    { max: 15000, points: 28 },
    { max: 30000, points: 35 },
    { max: Number.POSITIVE_INFINITY, points: 35 },
  ]);

  const bigAccountRaw = pickTier(signals?.bigAccountFollowers ?? 0, [
    { max: 0, points: 0 },
    { max: 2, points: 8 },
    { max: 5, points: 15 },
    { max: 10, points: 25 },
    { max: Number.POSITIVE_INFINITY, points: 25 },
  ]);

  const activeTraderRaw = pickTier(signals?.activeTraderFollowers ?? 0, [
    { max: 0, points: 0 },
    { max: 2, points: 10 },
    { max: 5, points: 15 },
    { max: 10, points: 20 },
    { max: 20, points: 25 },
    { max: 30, points: 30 },
    { max: Number.POSITIVE_INFINITY, points: 30 },
  ]);

  const topTraderRaw =
    signals?.topTraderFollowers && signals.topTraderFollowers > 0 ? 20 : 0;

  const active24hRaw = pickTier(signals?.active24hFollowers ?? 0, [
    { max: 0, points: 0 },
    { max: 2, points: 5 },
    { max: 5, points: 8 },
    { max: 10, points: 12 },
    { max: Number.POSITIVE_INFINITY, points: 15 },
  ]);

  const followerQualityRaw =
    followerRaw + bigAccountRaw + activeTraderRaw + topTraderRaw + active24hRaw;
  const followerQualityMax = 35 + 25 + 30 + 20 + 15;
  const farcasterFollowerQuality = buildBlock(
    "fc_follower_quality",
    followerQualityRaw,
    followerQualityMax,
    0.6,
    1,
  );

  const blocks = [
    farcasterDev,
    farcasterAge,
    farcasterPosts,
    farcasterFollowerQuality,
  ];
  const normalized =
    farcasterDev.normalized * 0.1 +
    farcasterAge.normalized * 0.2 +
    farcasterPosts.normalized * 0.1 +
    farcasterFollowerQuality.normalized * 0.6;
  const score = normalized * 50; // Farcaster bloğu toplam skora %50 katkı
  return { score, blocks };
};

const computeTwitterBlock = (signals: TwitterSignals | undefined) => {
  const ageDays = signals?.accountAgeDays ?? 0;
  const ageRaw = pickTier(ageDays, [
    { max: 7, points: 0 },
    { max: 30, points: 2 },
    { max: 180, points: 3 },
    { max: 365, points: 4 },
    { max: Number.POSITIVE_INFINITY, points: 5 },
  ]);
  const twitterAge = buildBlock("tw_age", ageRaw, 5, 0.05, 1);

  const followerRaw = pickTier(signals?.followerCount ?? 0, [
    { max: 200, points: 0 },
    { max: 1000, points: 3 },
    { max: 5000, points: 6 },
    { max: 15000, points: 8 },
    { max: 30000, points: 10 },
    { max: 75000, points: 15 },
    { max: 150000, points: 18 },
    { max: Number.POSITIVE_INFINITY, points: 20 },
  ]);
  const twitterFollowers = buildBlock("tw_followers", followerRaw, 20, 0.25, 1);

  const smartFollowersRaw = pickTier(signals?.smartFollowerCount ?? 0, [
    { max: 2, points: 0 },
    { max: 7, points: 5 },
    { max: 15, points: 10 },
    { max: 25, points: 15 },
    { max: 40, points: 20 },
    { max: 60, points: 25 },
    { max: 90, points: 30 },
    { max: 120, points: 35 },
    { max: 150, points: 38 },
    { max: Number.POSITIVE_INFINITY, points: 40 },
  ]);
  const twitterSmart = buildBlock("tw_smart_followers", smartFollowersRaw, 40, 0.65, 1);

  const ethosRaw =
    signals?.ethos === "high" ? 15 : signals?.ethos === "medium" ? 7 : 0;
  const twitterEthos = buildBlock("tw_ethos", ethosRaw, 15, 0.15, 1);

  const weightSum = 0.05 + 0.25 + 0.65 + 0.15;
  const normalized =
    (twitterAge.normalized * 0.05 +
      twitterFollowers.normalized * 0.25 +
      twitterSmart.normalized * 0.65 +
      twitterEthos.normalized * 0.15) /
    weightSum;
  const score = normalized * 50; // Twitter bloğu toplam skora %50 katkı

  return {
    score,
    blocks: [twitterAge, twitterFollowers, twitterSmart, twitterEthos],
  };
};

export const scoreClanker = (input: ClankerScoreInputs): ScoreResult => {
  const reasons: string[] = [];
  const devLaunchCount = input.farcaster?.developerLaunchCount;
  if (devLaunchCount !== undefined && devLaunchCount >= 4) {
    return {
      platform: "clanker",
      score: 0,
      allocationEth: 0,
      hardDrop: true,
      reasons: ["4+ lansman: hard drop"],
      blocks: [],
    };
  }

  const farcaster = computeFarcasterBlock(input.farcaster);
  const twitter = computeTwitterBlock(input.twitter);

  const totalScore = farcaster.score + twitter.score;
  const allocationEth = ethAllocationFromScore(totalScore);

  return {
    platform: "clanker",
    score: Number(totalScore.toFixed(2)),
    allocationEth,
    reasons: reasons.length ? reasons : undefined,
    blocks: [...farcaster.blocks, ...twitter.blocks],
  };
};

export const scoreZora = (input: ZoraScoreInputs): ScoreResult => {
  // Twitter bloğu (aynı alt ağırlıkları kullanıyoruz)
  const twitter = computeTwitterBlock(input.twitter);

  // Farcaster (Zora için düşük öncelik: yaş + follower, eşit paylaşım)
  const fcAge = pickTier(input.farcaster?.accountAgeDays ?? 0, [
    { max: 7, points: 0 },
    { max: 21, points: 10 },
    { max: 45, points: 15 },
    { max: 90, points: 18 },
    { max: 180, points: 21 },
    { max: 360, points: 24 },
    { max: Number.POSITIVE_INFINITY, points: 30 },
  ]);
  const fcFollowers = pickTier(input.farcaster?.followerCount ?? 0, [
    { max: 50, points: 0 },
    { max: 200, points: 5 },
    { max: 600, points: 8 },
    { max: 1500, points: 12 },
    { max: 3000, points: 18 },
    { max: 7500, points: 22 },
    { max: 15000, points: 28 },
    { max: 30000, points: 35 },
    { max: Number.POSITIVE_INFINITY, points: 35 },
  ]);
  const farcasterAge = buildBlock("fc_age_zora", fcAge, 30, 0.5, 1);
  const farcasterFollowers = buildBlock("fc_followers_zora", fcFollowers, 35, 0.5, 1);
  const fcNormalized =
    (farcasterAge.normalized * 0.5 + farcasterFollowers.normalized * 0.5) / 1;
  const fcScore = fcNormalized * 20; // %20 ağırlık

  // Zora iç sinyaller (şimdilik follower quality opsiyonel)
  const zoraFollowerQuality = buildBlock(
    "zora_follower_quality",
    input.zoraFollowerQuality ?? 0,
    100,
    1,
    1,
  );
  const zoraBlockScore = zoraFollowerQuality.normalized * 10; // %10 ağırlık

  const twitterWeighted = (twitter.score / 50) * 70; // Twitter bloğu 0-70
  const totalScore = twitterWeighted + fcScore + zoraBlockScore;
  const allocationEth = ethAllocationFromScore(totalScore);

  const blocks: ScoreBlockBreakdown[] = [
    ...twitter.blocks.map((b) => ({ ...b, weight: b.weight, name: b.name })),
    farcasterAge,
    farcasterFollowers,
    zoraFollowerQuality,
  ];

  return {
    platform: "zora",
    score: Number(totalScore.toFixed(2)),
    allocationEth,
    blocks,
  };
};
