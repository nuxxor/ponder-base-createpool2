/**
 * Uniswap V4 Swap Implementation
 *
 * Used for Zora tokens which use V4 pools with hooks
 *
 * Zora coins use a custom hook that:
 * - Converts fees into payout token
 * - Distributes rewards to creators/referrers
 *
 * V4 Architecture:
 * - PoolManager is the central contract
 * - Pools are identified by PoolKey (not address)
 * - Swaps go through PoolManager.swap()
 * - Hooks can modify swap behavior
 */

import { encodeFunctionData, formatEther, parseEther, encodeAbiParameters, parseAbiParameters } from "viem";
import { WalletService } from "../services/wallet";
import { CONTRACTS, type SwapResult, type ZoraPoolKey } from "./types";

// V4 PoolManager ABI (minimal for swaps)
const POOL_MANAGER_ABI = [
  {
    name: "swap",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "zeroForOne", type: "bool" },
          { name: "amountSpecified", type: "int256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "delta", type: "int256" }],
  },
  {
    name: "unlock",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ name: "result", type: "bytes" }],
  },
] as const;

// Zora uses their own swap router for V4 pools
// This is a simplified implementation - in production, use Zora SDK
const ZORA_SWAP_HELPER_ABI = [
  {
    name: "buy",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "coin", type: "address" },
      { name: "minAmountOut", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "referrer", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "sell",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "coin", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "referrer", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

// Known Zora contract addresses
const ZORA_CONTRACTS = {
  // Zora's V4 swap helper (if exists)
  // Note: This may need to be updated based on Zora's actual deployment
  COIN_SWAP_HELPER: "0x0000000000000000000000000000000000000000" as `0x${string}`, // TBD

  // Zora Hook address (unified for all coins)
  UNIFIED_HOOK: "0x0000000000000000000000000000000000000000" as `0x${string}`, // TBD

  // Creator coin factory
  COIN_FACTORY: "0x777777751622c0d3258f214F9DF38E35BF45baF3" as `0x${string}`,
} as const;

/**
 * Get Zora coin info to determine swap path
 */
async function getZoraCoinInfo(
  wallet: WalletService,
  coinAddress: `0x${string}`
): Promise<{ isCreatorCoin: boolean; backingCurrency: `0x${string}` } | null> {
  try {
    // Query Zora API for coin info
    const ZORA_API_KEY = process.env.ZORA_API_KEY;
    const ZORA_API_BASE = process.env.ZORA_API_BASE || "https://api-sdk.zora.engineering";

    const url = new URL("/coin", ZORA_API_BASE);
    url.searchParams.set("address", coinAddress);
    url.searchParams.set("chain", "8453");

    const res = await fetch(url, {
      headers: { "api-key": ZORA_API_KEY ?? "", Accept: "application/json" },
    });

    if (!res.ok) return null;

    const data = await res.json() as any;
    const token = data?.data?.zora20Token ?? data?.zora20Token;

    if (!token) return null;

    return {
      isCreatorCoin: token.type === "creator",
      backingCurrency: (token.backingCurrency ?? CONTRACTS.WETH) as `0x${string}`,
    };
  } catch (error) {
    console.error("[v4swap] Failed to get Zora coin info:", error);
    return null;
  }
}

/**
 * Execute V4 swap for Zora coins
 *
 * NOTE: V4 swaps are more complex than V3:
 * - Requires understanding of poolKey structure
 * - Need to handle Zora's custom hook logic
 * - May need to use Zora's SDK for proper execution
 *
 * For now, we'll use a simpler approach:
 * 1. Try direct swap via UniversalRouter V4 commands
 * 2. Fall back to V3 if V4 path not available (some Zora coins have V3 liquidity)
 */
export async function executeV4Swap(
  wallet: WalletService,
  coinAddress: `0x${string}`,
  amountIn: bigint,
  slippagePercent: number = 15, // Higher slippage for V4/Zora
  poolKey?: ZoraPoolKey
): Promise<SwapResult> {
  const startTime = Date.now();

  try {
    console.log(`[v4swap] Starting Zora swap: ${formatEther(amountIn)} ETH -> ${coinAddress}`);

    // Get coin info
    const coinInfo = await getZoraCoinInfo(wallet, coinAddress);
    console.log(`[v4swap] Coin info:`, coinInfo);

    // For now, return not implemented
    // In production, this would use:
    // 1. Zora SDK's buy() function
    // 2. Or direct PoolManager interaction with proper unlock/callback pattern
    // 3. Or UniversalRouter with V4 commands

    // Placeholder: Try to find V3 pool for this Zora coin (some have both)
    console.log(`[v4swap] V4 direct swap not yet implemented, checking for V3 pool...`);

    // Import V3 swap as fallback
    const { buyTokenV3 } = await import("./uniswapV3");
    const v3Result = await buyTokenV3(wallet, coinAddress, amountIn, slippagePercent);

    if (v3Result.success) {
      console.log(`[v4swap] Successfully swapped via V3 fallback`);
      return v3Result;
    }

    // If V3 also fails, return error with guidance
    return {
      success: false,
      amountIn,
      error: "V4 swap not implemented yet. Token may only have V4 liquidity. " +
             "Consider using Zora's website or SDK directly.",
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[v4swap] Swap failed:`, errorMsg);

    return {
      success: false,
      amountIn,
      error: errorMsg,
    };
  }
}

/**
 * Buy Zora coin with ETH
 *
 * This is a higher-level function that:
 * 1. Detects the correct swap path (V3 or V4)
 * 2. Executes the swap
 */
export async function buyZoraCoin(
  wallet: WalletService,
  coinAddress: `0x${string}`,
  ethAmount: bigint,
  slippagePercent: number = 15
): Promise<SwapResult> {
  return executeV4Swap(wallet, coinAddress, ethAmount, slippagePercent);
}

/**
 * Future implementation notes for full V4 support:
 *
 * 1. PoolManager.unlock() pattern:
 *    - V4 uses a callback pattern for flash accounting
 *    - Need to implement IUnlockCallback interface
 *    - swap() is called within the callback
 *
 * 2. Zora SDK:
 *    - Zora provides SDK for coin operations
 *    - May be easier to use than raw V4 calls
 *    - Check: @zoralabs/coins-sdk
 *
 * 3. UniversalRouter V4:
 *    - Supports both V3 and V4 in one tx
 *    - Uses command pattern
 *    - Encode V4_SWAP command with poolKey
 *
 * Example V4 swap via UniversalRouter:
 *
 * const commands = encodePacked(['uint8'], [Commands.V4_SWAP]);
 * const inputs = [
 *   encodePoolKey(poolKey),
 *   encodeSwapParams(params),
 *   hookData
 * ];
 * router.execute(commands, inputs, deadline);
 */
