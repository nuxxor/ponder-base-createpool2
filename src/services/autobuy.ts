/**
 * Auto-Buy Service
 *
 * Main service for automatic token purchases when signals are detected
 */

import { parseEther, formatEther } from "viem";
import { WalletService, getWallet, hasWalletConfigured } from "./wallet";
import { buyTokenV3 } from "../swap/uniswapV3";
import { buyZoraCoin } from "../swap/uniswapV4";
import { sendSimpleMessage } from "./telegram";
import { SwapResult, TradeRecord } from "../swap/types";
import * as fs from "fs";
import * as path from "path";

// Configuration from environment
const getConfig = () => ({
  enabled: process.env.AUTOBUY_ENABLED === "true",
  amountEth: Number(process.env.AUTOBUY_AMOUNT_ETH || "0.01"),
  maxDailyEth: Number(process.env.AUTOBUY_MAX_DAILY_ETH || "0.5"),
  slippagePercent: Number(process.env.AUTOBUY_SLIPPAGE_PERCENT || "10"),
  minLiquidityUsd: Number(process.env.AUTOBUY_MIN_LIQUIDITY_USD || "5000"),
  instantBigAccounts: process.env.AUTOBUY_INSTANT_BIG_ACCOUNTS !== "false",
  requireTelegram: process.env.AUTOBUY_REQUIRE_TELEGRAM === "true",
});

// Trade history file
const TRADES_LOG_FILE = path.join(process.cwd(), "data", "trades.jsonl");
const DAILY_STATS_FILE = path.join(process.cwd(), "data", "autobuy_daily.json");

// Daily tracking
interface DailyStats {
  date: string;
  totalSpentEth: number;
  tradeCount: number;
  successCount: number;
  failCount: number;
}

const getToday = () => new Date().toISOString().split("T")[0] ?? "";

const createEmptyDailyStats = (date = getToday()): DailyStats => ({
  date,
  totalSpentEth: 0,
  tradeCount: 0,
  successCount: 0,
  failCount: 0,
});

let dailyStats: DailyStats = createEmptyDailyStats();
let dailyStatsDirty = false;
let dailyStatsInit: Promise<void> | null = null;
let dailyStatsWriteQueue: Promise<void> = Promise.resolve();

const enqueueDailyStatsWrite = async (task: () => Promise<void>) => {
  dailyStatsWriteQueue = dailyStatsWriteQueue.then(task, task);
  await dailyStatsWriteQueue;
};

const flushDailyStats = async () => {
  if (!dailyStatsDirty) return;
  dailyStatsDirty = false;

  try {
    const dataDir = path.dirname(DAILY_STATS_FILE);
    await fs.promises.mkdir(dataDir, { recursive: true });

    const tmpPath = `${DAILY_STATS_FILE}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;
    await enqueueDailyStatsWrite(async () => {
      await fs.promises.writeFile(
        tmpPath,
        JSON.stringify(dailyStats, null, 2) + "\n",
        "utf8",
      );
      await fs.promises.rename(tmpPath, DAILY_STATS_FILE);
    });
  } catch (error) {
    dailyStatsDirty = true;
    console.warn(
      "[autobuy] Failed to persist daily stats:",
      error instanceof Error ? error.message : error,
    );
  }
};

const initDailyStats = async () => {
  if (dailyStatsInit) return dailyStatsInit;

  dailyStatsInit = (async () => {
    try {
      const raw = await fs.promises.readFile(DAILY_STATS_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<DailyStats>;
      if (
        typeof parsed?.date === "string" &&
        typeof parsed?.totalSpentEth === "number" &&
        typeof parsed?.tradeCount === "number" &&
        typeof parsed?.successCount === "number" &&
        typeof parsed?.failCount === "number"
      ) {
        dailyStats = {
          date: parsed.date,
          totalSpentEth: parsed.totalSpentEth,
          tradeCount: parsed.tradeCount,
          successCount: parsed.successCount,
          failCount: parsed.failCount,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[autobuy] Failed to load daily stats (starting fresh):",
          error instanceof Error ? error.message : error,
        );
      }
    }

    checkDailyReset();
    await flushDailyStats();
  })();

  return dailyStatsInit;
};

// Reset daily stats if new day
function checkDailyReset(): void {
  const today = getToday();
  if (dailyStats.date !== today) {
    console.log(`[autobuy] New day detected, resetting daily stats`);
    dailyStats = createEmptyDailyStats(today);
    dailyStatsDirty = true;
  }
}

export interface BuyRequest {
  tokenAddress: `0x${string}`;
  symbol?: string;
  name?: string;
  platform: "clanker" | "zora";
  poolAddress?: `0x${string}`;
  liquidity?: number;
  creatorInfo?: {
    twitterFollowers?: number;
    farcasterFollowers?: number;
    twitterHandle?: string;
  };
}

export interface BuyResult {
  success: boolean;
  txHash?: `0x${string}`;
  amountSpentEth?: string;
  tokensReceived?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Log trade to file for history/analytics
 */
async function logTrade(
  request: BuyRequest,
  result: SwapResult,
  amountEth: number
): Promise<void> {
  try {
    const record: TradeRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      token: request.tokenAddress,
      symbol: request.symbol,
      platform: request.platform,
      txHash: result.txHash!,
      amountInEth: amountEth.toString(),
      amountOutTokens: result.amountOut?.toString() || "unknown",
      pricePerToken: (() => {
        if (!result.amountOut || result.amountOut <= 0n) return "unknown";
        const amountOutNumber = Number(result.amountOut);
        if (!Number.isFinite(amountOutNumber) || amountOutNumber <= 0) {
          return "unknown";
        }
        return (amountEth / amountOutNumber).toExponential(4);
      })(),
      status: result.success ? "success" : "failed",
    };

    // Ensure data directory exists
    const dataDir = path.dirname(TRADES_LOG_FILE);
    await fs.promises.mkdir(dataDir, { recursive: true });

    await fs.promises.appendFile(
      TRADES_LOG_FILE,
      JSON.stringify(record) + "\n",
      "utf8"
    );
  } catch (error) {
    console.error("[autobuy] Failed to log trade:", error);
  }
}

/**
 * Send Telegram notification for trade
 */
async function notifyTrade(
  request: BuyRequest,
  result: BuyResult,
  amountEth: number
): Promise<void> {
  try {
    if (result.success) {
      const message = [
        `✅ *AUTO\\-BUY EXECUTED*`,
        ``,
        `*Token:* \`${request.tokenAddress}\``,
        request.symbol ? `*Symbol:* ${escapeMarkdown(request.symbol)}` : null,
        `*Platform:* ${request.platform}`,
        ``,
        `💰 *Trade:*`,
        `• Spent: ${amountEth} ETH`,
        result.tokensReceived ? `• Received: ${result.tokensReceived} tokens` : null,
        ``,
        `🔗 [Basescan](https://basescan.org/tx/${result.txHash})`,
        `📊 [DexScreener](https://dexscreener.com/base/${request.tokenAddress})`,
      ]
        .filter(Boolean)
        .join("\n");

      await sendSimpleMessage(message);
    } else {
      const message = [
        `❌ *AUTO\\-BUY FAILED*`,
        ``,
        `*Token:* \`${request.tokenAddress}\``,
        request.symbol ? `*Symbol:* ${escapeMarkdown(request.symbol)}` : null,
        `*Platform:* ${request.platform}`,
        ``,
        `*Error:* ${escapeMarkdown(result.error || "Unknown error")}`,
      ]
        .filter(Boolean)
        .join("\n");

      await sendSimpleMessage(message);
    }
  } catch (error) {
    console.error("[autobuy] Failed to send notification:", error);
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

/**
 * Check if auto-buy should proceed
 */
function shouldProceed(request: BuyRequest): { proceed: boolean; reason?: string } {
  const config = getConfig();

  // Check if enabled
  if (!config.enabled) {
    return { proceed: false, reason: "Auto-buy disabled" };
  }

  // Check wallet configuration
  if (!hasWalletConfigured()) {
    return { proceed: false, reason: "Wallet not configured" };
  }

  // Check daily limit
  checkDailyReset();
  if (dailyStats.totalSpentEth >= config.maxDailyEth) {
    return { proceed: false, reason: `Daily limit reached (${config.maxDailyEth} ETH)` };
  }

  // Check minimum liquidity (skip for big accounts)
  const isBigAccount =
    request.creatorInfo?.twitterFollowers &&
    request.creatorInfo.twitterFollowers >= 70000;

  if (!isBigAccount && request.liquidity !== undefined) {
    if (request.liquidity < config.minLiquidityUsd) {
      return {
        proceed: false,
        reason: `Liquidity too low ($${request.liquidity} < $${config.minLiquidityUsd})`,
      };
    }
  }

  return { proceed: true };
}

// Serialize auto-buy execution to avoid race conditions on daily limits and balances.
let buyQueue: Promise<void> = Promise.resolve();
const enqueueBuy = async <T>(task: () => Promise<T>): Promise<T> => {
  const result = buyQueue.then(task, task);
  buyQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

/**
 * Execute auto-buy for a token
 */
async function executeBuyInner(request: BuyRequest): Promise<BuyResult> {
  await initDailyStats();
  checkDailyReset();
  await flushDailyStats();

  const config = getConfig();
  const startTime = Date.now();

  console.log(`[autobuy] Processing buy request for ${request.symbol || request.tokenAddress}`);

  // Check if we should proceed
  const { proceed, reason } = shouldProceed(request);
  if (!proceed) {
    console.log(`[autobuy] Skipped: ${reason}`);
    await flushDailyStats();
    return { success: false, skipped: true, skipReason: reason };
  }

  // Get wallet
  let wallet: WalletService;
  try {
    wallet = getWallet();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Wallet init failed";
    console.error(`[autobuy] Wallet error:`, errorMsg);
    return { success: false, error: errorMsg };
  }

  // Check balance
  const balance = await wallet.getBalance();
  const amountWei = parseEther(config.amountEth.toString());

  if (balance < amountWei) {
    const balanceEth = formatEther(balance);
    const error = `Insufficient balance: ${balanceEth} ETH < ${config.amountEth} ETH`;
    console.log(`[autobuy] ${error}`);
    return { success: false, error };
  }

  // Update stats
  dailyStats.tradeCount++;
  dailyStatsDirty = true;
  await flushDailyStats();

  // Execute swap based on platform
  let swapResult: SwapResult;

  try {
    if (request.platform === "clanker") {
      console.log(`[autobuy] Executing V3 swap for Clanker token...`);
      swapResult = await buyTokenV3(
        wallet,
        request.tokenAddress,
        amountWei,
        config.slippagePercent
      );
    } else {
      console.log(`[autobuy] Executing V4 swap for Zora token...`);
      swapResult = await buyZoraCoin(
        wallet,
        request.tokenAddress,
        amountWei,
        config.slippagePercent + 5 // Extra slippage for Zora
      );
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Swap execution failed";
    console.error(`[autobuy] Swap error:`, errorMsg);

    dailyStats.failCount++;
    dailyStatsDirty = true;
    await flushDailyStats();
    const result: BuyResult = { success: false, error: errorMsg };
    await notifyTrade(request, result, config.amountEth);
    return result;
  }

  // Process result
  const elapsed = Date.now() - startTime;

  if (swapResult.success) {
    dailyStats.successCount++;
    dailyStats.totalSpentEth += config.amountEth;
    dailyStatsDirty = true;
    await flushDailyStats();

    console.log(`[autobuy] ✅ Buy successful in ${elapsed}ms: ${swapResult.txHash}`);

    // Log trade
    await logTrade(request, swapResult, config.amountEth);

    const result: BuyResult = {
      success: true,
      txHash: swapResult.txHash,
      amountSpentEth: config.amountEth.toString(),
      tokensReceived: swapResult.amountOut?.toString(),
    };

    // Send notification
    await notifyTrade(request, result, config.amountEth);

    return result;
  } else {
    dailyStats.failCount++;
    dailyStatsDirty = true;
    await flushDailyStats();

    console.log(`[autobuy] ❌ Buy failed in ${elapsed}ms: ${swapResult.error}`);

    const result: BuyResult = {
      success: false,
      error: swapResult.error,
    };

    await notifyTrade(request, result, config.amountEth);

    return result;
  }
}

export async function executeBuy(request: BuyRequest): Promise<BuyResult> {
  return enqueueBuy(() => executeBuyInner(request));
}

/**
 * Get current daily stats
 */
export function getDailyStats(): DailyStats {
  checkDailyReset();
  return { ...dailyStats };
}

/**
 * Check if auto-buy is properly configured and ready
 */
export function isAutoBuyReady(): {
  ready: boolean;
  enabled: boolean;
  walletConfigured: boolean;
  config: ReturnType<typeof getConfig>;
} {
  const config = getConfig();
  const walletConfigured = hasWalletConfigured();

  return {
    ready: config.enabled && walletConfigured,
    enabled: config.enabled,
    walletConfigured,
    config,
  };
}

/**
 * Get wallet info (for logging/debugging)
 */
export async function getWalletInfo(): Promise<{
  address: string;
  balanceEth: string;
} | null> {
  if (!hasWalletConfigured()) {
    return null;
  }

  try {
    const wallet = getWallet();
    const balance = await wallet.getBalanceEth();
    return {
      address: wallet.address,
      balanceEth: balance,
    };
  } catch {
    return null;
  }
}
