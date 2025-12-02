export type ScoreBlockBreakdown = {
  name: string;
  raw: number;
  max: number;
  weight: number;
  normalized: number;
  weighted: number;
};

export type ScoreResult = {
  platform: "clanker" | "zora";
  score: number;
  allocationEth: number;
  hardDrop?: boolean;
  reasons?: string[];
  blocks: ScoreBlockBreakdown[];
};

export type FarcasterSignals = {
  fid?: number;
  accountAgeDays?: number;
  postCount?: number;
  followerCount?: number;
  bigAccountFollowers?: number;
  activeTraderFollowers?: number;
  topTraderFollowers?: number;
  active24hFollowers?: number;
  developerLaunchCount?: number;
  neynarScore?: number;
};

export type TwitterSignals = {
  accountAgeDays?: number;
  followerCount?: number;
  smartFollowerCount?: number;
  ethos?: "low" | "medium" | "high";
};

export type ClankerScoreInputs = {
  farcaster?: FarcasterSignals;
  twitter?: TwitterSignals;
};

export type ZoraScoreInputs = {
  twitter?: TwitterSignals;
  farcaster?: Pick<FarcasterSignals, "accountAgeDays" | "followerCount">;
  zoraFollowerCount?: number;
  zoraFollowerQuality?: number;
};
