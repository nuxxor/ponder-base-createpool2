/**
 * Uniswap V3 Swap Implementation
 *
 * Used for Clanker tokens which use V3 pools
 */

import { encodeFunctionData, parseEther, formatEther } from "viem";
import { WalletService } from "../services/wallet";
import { CONTRACTS, FEE_TIERS, type SwapParams, type SwapQuote, type SwapResult } from "./types";

// SwapRouter02 ABI (minimal)
const SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "data", type: "bytes[]" },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

// QuoterV2 ABI (minimal)
const QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// WETH ABI for deposit
const WETH_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;

/**
 * Get quote for V3 swap
 */
export async function quoteV3Swap(
  wallet: WalletService,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  fee: number = FEE_TIERS.HIGH
): Promise<SwapQuote | null> {
  try {
    const publicClient = wallet.getPublicClient();

    // Try to get quote (this is a static call simulation)
    const result = await publicClient.simulateContract({
      address: CONTRACTS.QUOTER_V2,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: CONTRACTS.WETH,
          tokenOut,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    const [amountOut, , , gasEstimate] = result.result as [bigint, bigint, number, bigint];

    return {
      amountOut,
      amountOutMinimum: amountOut, // Will be adjusted with slippage
      gasEstimate,
    };
  } catch (error) {
    console.error("[v3swap] Quote failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Find the best fee tier for a token pair
 */
export async function findBestFeeTier(
  wallet: WalletService,
  tokenOut: `0x${string}`,
  amountIn: bigint
): Promise<number> {
  const feeTiers = [FEE_TIERS.HIGH, FEE_TIERS.MEDIUM, FEE_TIERS.LOW, FEE_TIERS.LOWEST];

  for (const fee of feeTiers) {
    const quote = await quoteV3Swap(wallet, tokenOut, amountIn, fee);
    if (quote && quote.amountOut > 0n) {
      console.log(`[v3swap] Found pool with fee tier ${fee / 10000}%`);
      return fee;
    }
  }

  // Default to 1% for memecoins
  console.log(`[v3swap] No pool found, defaulting to 1% fee tier`);
  return FEE_TIERS.HIGH;
}

/**
 * Execute V3 swap (ETH -> Token)
 *
 * Flow:
 * 1. Wrap ETH to WETH
 * 2. Approve WETH for SwapRouter
 * 3. Execute exactInputSingle swap
 */
export async function executeV3Swap(
  wallet: WalletService,
  params: SwapParams
): Promise<SwapResult> {
  const startTime = Date.now();

  try {
    console.log(`[v3swap] Starting swap: ${formatEther(params.amountIn)} ETH -> ${params.tokenOut}`);

    // 1. Find best fee tier
    const fee = params.poolFee || await findBestFeeTier(wallet, params.tokenOut, params.amountIn);

    // 2. Get quote
    const quote = await quoteV3Swap(wallet, params.tokenOut, params.amountIn, fee);
    if (!quote) {
      return { success: false, amountIn: params.amountIn, error: "Failed to get quote - no liquidity?" };
    }

    console.log(`[v3swap] Quote: ${quote.amountOut} tokens expected`);

    // 3. Calculate minimum output with slippage
    const slippageMultiplier = BigInt(Math.floor((100 - params.slippagePercent) * 100));
    const amountOutMinimum = (quote.amountOut * slippageMultiplier) / 10000n;

    console.log(`[v3swap] Min output with ${params.slippagePercent}% slippage: ${amountOutMinimum}`);

    // 4. Check WETH balance and wrap if needed
    const wethBalance = await wallet.getTokenBalance(CONTRACTS.WETH);
    if (wethBalance < params.amountIn) {
      console.log(`[v3swap] Wrapping ${formatEther(params.amountIn)} ETH to WETH...`);
      const wrapHash = await wallet.writeContract({
        address: CONTRACTS.WETH,
        abi: WETH_ABI,
        functionName: "deposit",
        value: params.amountIn,
      });
      await wallet.waitForTransaction(wrapHash);
      console.log(`[v3swap] Wrapped ETH: ${wrapHash}`);
    }

    // 5. Approve WETH for SwapRouter if needed
    const allowance = await wallet.getAllowance(CONTRACTS.WETH, CONTRACTS.SWAP_ROUTER_02);
    if (allowance < params.amountIn) {
      console.log(`[v3swap] Approving WETH for SwapRouter...`);
      const approveHash = await wallet.approveToken(
        CONTRACTS.WETH,
        CONTRACTS.SWAP_ROUTER_02,
        params.amountIn * 2n // Approve 2x to avoid future approvals
      );
      await wallet.waitForTransaction(approveHash);
    }

    // 6. Get gas settings
    const { maxFeePerGas, maxPriorityFeePerGas } = await wallet.getGasPrice();

    // 7. Execute swap
    console.log(`[v3swap] Executing swap...`);
    const swapHash = await wallet.writeContract({
      address: CONTRACTS.SWAP_ROUTER_02,
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: CONTRACTS.WETH,
          tokenOut: params.tokenOut,
          fee,
          recipient: params.recipient,
          amountIn: params.amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    console.log(`[v3swap] Swap TX submitted: ${swapHash}`);

    // 8. Wait for confirmation
    const receipt = await wallet.waitForTransaction(swapHash);

    if (receipt.status === "reverted") {
      return {
        success: false,
        txHash: swapHash,
        amountIn: params.amountIn,
        error: "Transaction reverted",
      };
    }

    // 9. Get actual token balance received
    const tokenBalance = await wallet.getTokenBalance(params.tokenOut);

    const elapsed = Date.now() - startTime;
    console.log(`[v3swap] Swap successful in ${elapsed}ms: ${swapHash}`);

    return {
      success: true,
      txHash: swapHash,
      amountIn: params.amountIn,
      amountOut: tokenBalance, // Actual received (may differ from quote)
      gasUsed: receipt.gasUsed,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[v3swap] Swap failed:`, errorMsg);

    return {
      success: false,
      amountIn: params.amountIn,
      error: errorMsg,
    };
  }
}

/**
 * Convenience function: Buy token with ETH using V3
 */
export async function buyTokenV3(
  wallet: WalletService,
  tokenAddress: `0x${string}`,
  ethAmount: bigint,
  slippagePercent: number = 10
): Promise<SwapResult> {
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes

  return executeV3Swap(wallet, {
    tokenIn: CONTRACTS.WETH,
    tokenOut: tokenAddress,
    amountIn: ethAmount,
    slippagePercent,
    recipient: wallet.address,
    deadline,
  });
}
