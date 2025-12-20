/**
 * Swap Types for Auto-Buy Module
 */

export interface SwapParams {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  slippagePercent: number;
  recipient: `0x${string}`;
  deadline: number;
  poolFee?: number;
}

export interface SwapQuote {
  amountOut: bigint;
  amountOutMinimum: bigint;
  priceImpact?: number;
  gasEstimate?: bigint;
}

export interface SwapResult {
  success: boolean;
  txHash?: `0x${string}`;
  amountIn: bigint;
  amountOut?: bigint;
  gasUsed?: bigint;
  error?: string;
}

export interface ZoraPoolKey {
  currency: `0x${string}`;
  token0: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

export interface TradeRecord {
  id: string;
  timestamp: string;
  token: `0x${string}`;
  symbol?: string;
  platform: "clanker" | "zora";
  txHash: `0x${string}`;
  amountInEth: string;
  amountOutTokens: string;
  pricePerToken: string;
  status: "success" | "failed" | "pending";
}

// Base Mainnet Contract Addresses
export const CONTRACTS = {
  // Tokens
  WETH: "0x4200000000000000000000000000000000000006" as `0x${string}`,
  USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as `0x${string}`,

  // Uniswap V3 (Clanker)
  SWAP_ROUTER_02: "0x2626664c2603336E57B271c5C0b26F421741e481" as `0x${string}`,
  UNIVERSAL_ROUTER: "0x6fF5693b99212Da76ad316178A184AB56D299b43" as `0x${string}`,
  QUOTER_V2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as `0x${string}`,
  UNISWAP_V3_FACTORY: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as `0x${string}`,

  // Uniswap V4 (Zora)
  POOL_MANAGER_V4: "0x7Da1D65F8B249183667cdE74C5CBD46dD38AA829" as `0x${string}`,
} as const;

// Common fee tiers for Uniswap V3
export const FEE_TIERS = {
  LOWEST: 100,    // 0.01%
  LOW: 500,       // 0.05%
  MEDIUM: 3000,   // 0.3%
  HIGH: 10000,    // 1% - common for memecoins
} as const;
