export type Platform =
  | "farcaster"
  | "zora"
  | "virtuals"
  | "clanker"
  | "ape_store"
  | "creator_bid"
  | "flaunch"
  | "long_xyz";

export type SocialProvider = "twitter" | "farcaster";

export interface SocialStat {
  provider: SocialProvider;
  handle: string;
  fid?: number;
  followers?: number | null;
  lastCheckedAt?: string;
  source?: string;
  error?: string;
}

export type SmartFollowerSample = {
  rank?: number;
  name?: string;
  tier?: string;
  score?: number;
  smarts?: number;
};

export interface SmartFollowerReport {
  provider: "moni";
  handle: string;
  lastCheckedAt: string;
  totalSmarts?: number;
  moniScore?: number;
  followers?: number;
  topSample?: SmartFollowerSample[];
}

export interface CreatorVerification {
  passes: boolean;
  checkedAt: string;
  reasons: string[];
  farcasterFollowers?: number | null;
  fid?: number | string;
  handle?: string;
  msgSender?: `0x${string}` | string | null;
  msgSenderVerified?: boolean;
  zora?: {
    fid?: number | string | null;
    handle?: string | null;
    followers?: number | null;
    creatorVisible?: boolean;
  };
  sources?: {
    clanker?: {
      platform?: string | null;
      requestorFid?: number | null;
      msgSender?: `0x${string}` | string | null;
    };
  };
}

export interface Identity {
  platform?: Platform;
  creatorFid?: number;
  custodyAddress?: `0x${string}`;
  verifiedAddrs?: `0x${string}`[];
  twitter?: string;
  github?: string;
  website?: string;
  farcasterUsername?: string;
  score?: number;
  smartAccount?: {
    handle: string;
    url?: string;
    source?: string;
  };
  launchCount?: number;
  socialStats?: {
    twitter?: SocialStat;
    farcaster?: SocialStat;
  };
  smartFollowers?: SmartFollowerReport;
  creatorVerification?: CreatorVerification;
}

export interface TokenMeta {
  chainId: number;
  address: `0x${string}`;
  symbol?: string;
  name?: string;
  decimals?: number;
  createdAt?: string;
  poolAddress?: `0x${string}`;
  feeTier?: number;
  stable?: boolean;
  factory?: `0x${string}`;
  txHash?: `0x${string}`;
  quote?: `0x${string}`;
}

export interface LaunchSchedule {
  scheduledAt?: string;
  lpDeployedAt?: string;
  graduationAt?: string;
  source?: Platform;
}

export interface NewTokenCandidate {
  platform: Platform;
  identity: Identity;
  token: TokenMeta;
  schedule?: LaunchSchedule;
  community?: {
    websites?: string[];
    twitter?: string;
    telegram?: string;
    discord?: string;
    github?: string;
    raw?: Array<{ platform: string; url: string; handle?: string }>;
  };
  security?: {
    owner?: `0x${string}` | "renounced" | "unknown";
    lpLock?: { percent?: number; locker?: string } | null;
    labels?: string[];
  };
}
