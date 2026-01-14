import "../env";
import { withRetry } from "../utils/retry";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.BASE_DEGEN_ALARM;

// Rate limiting: max 30 messages per second (Telegram limit)
let lastMessageTime = 0;
const MIN_MESSAGE_INTERVAL_MS = 50; // ~20 messages/second max

// Serialize sends within a process to avoid overlapping rate-limit windows.
let sendQueue: Promise<void> = Promise.resolve();

const enqueueSend = async <T>(task: () => Promise<T>): Promise<T> => {
  const result = sendQueue.then(task, task);
  sendQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

if (!BOT_TOKEN) {
  console.warn("[telegram] TELEGRAM_BOT_TOKEN not set - notifications disabled");
}
if (!CHAT_ID) {
  console.warn("[telegram] BASE_DEGEN_ALARM chat ID not set - notifications disabled");
}

export interface TokenAlert {
  token: string;
  symbol?: string;
  name?: string;
  platform?: string;
  liquidity?: number;
  volume24h?: number;
  buysH1?: number;
  sellsH1?: number;
  priceChange?: number;
  score: number;
  neynarScore?: number;
  twitterFollowers?: number;
  farcasterFollowers?: number;
  poolAddress?: string;
  dexscreenerUrl?: string;
  creatorFid?: number;
  twitterHandle?: string;
  farcasterUsername?: string;
}

const escapeMarkdown = (text: string): string => {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

// Escape for MarkdownV2 but preserve the number format
const escapeNumber = (num: number | string): string => {
  return String(num).replace(/\./g, '\\.');
};

// Format number with locale and escape dots
const formatNumber = (num: number): string => {
  return num.toLocaleString().replace(/\./g, '\\.');
};

export const formatTokenAlert = (alert: TokenAlert): string => {
  const lines: string[] = [];

  // Helper to escape URL dots for MarkdownV2
  const escapeUrl = (url: string): string => url.replace(/\./g, '\\.');

  const isCreateAlert = alert.liquidity === undefined;
  // Big account = create-time alert (70K+ Twitter)
  const isBigAccount = isCreateAlert && (alert.twitterFollowers ?? 0) >= 70000;

  if (isBigAccount) {
    lines.push(`🚀 *BIG ACCOUNT \\(CREATE\\) ALERT*`);
  } else if (isCreateAlert) {
    lines.push(`⚡ *TOKEN CREATED*`);
  } else {
    lines.push(`🚨 *NEW PROMISING TOKEN*`);
  }
  lines.push(``);
  lines.push(`*Token:* \`${alert.token}\``);

  if (alert.symbol) {
    lines.push(`*Symbol:* ${escapeMarkdown(alert.symbol)}`);
  }
  if (alert.name) {
    lines.push(`*Name:* ${escapeMarkdown(alert.name)}`);
  }
  if (alert.platform) {
    lines.push(`*Platform:* ${escapeMarkdown(alert.platform)}`);
  }

  lines.push(``);
  lines.push(`📊 *Metrics:*`);
  if (isCreateAlert) {
    lines.push(`• Liquidity: ⏳ pending`);
  } else if (typeof alert.liquidity === "number") {
    lines.push(`• Liquidity: $${formatNumber(alert.liquidity)}`);
  }
  if (alert.volume24h) {
    lines.push(`• Volume 24h: $${formatNumber(alert.volume24h)}`);
  }
  if (alert.buysH1 !== undefined && alert.sellsH1 !== undefined) {
    lines.push(`• Buys/Sells 1h: ${alert.buysH1}/${alert.sellsH1}`);
  }
  if (alert.priceChange !== undefined) {
    const emoji = alert.priceChange >= 0 ? '📈' : '📉';
    lines.push(`• Price 1h: ${emoji} ${escapeNumber(alert.priceChange.toFixed(1))}%`);
  }
  lines.push(`• Score: ${alert.score}/8`);

  lines.push(``);
  lines.push(`👤 *Social:*`);
  if (alert.neynarScore !== undefined) {
    lines.push(`• Neynar Score: ${escapeNumber((alert.neynarScore * 100).toFixed(0))}%`);
  }
  if (alert.twitterFollowers) {
    lines.push(`• Twitter: ${formatNumber(alert.twitterFollowers)} followers`);
  }
  if (alert.farcasterFollowers) {
    lines.push(`• Farcaster: ${formatNumber(alert.farcasterFollowers)} followers`);
  }
  if (alert.creatorFid) {
    lines.push(`• Creator FID: ${alert.creatorFid}`);
  }

  lines.push(``);
  lines.push(`🔗 *Links:*`);
  if (alert.dexscreenerUrl) {
    lines.push(`[DexScreener](${escapeUrl(alert.dexscreenerUrl)})`);
  } else {
    lines.push(`[DexScreener](${escapeUrl(`https://dexscreener.com/base/${alert.token}`)})`);
  }
  lines.push(`[Basescan](${escapeUrl(`https://basescan.org/token/${alert.token}`)})`);

  // Social profile links
  if (alert.twitterHandle) {
    lines.push(`[Twitter](${escapeUrl(`https://x.com/${alert.twitterHandle}`)})`);
  }
  if (alert.farcasterUsername) {
    lines.push(`[Farcaster](${escapeUrl(`https://warpcast.com/${alert.farcasterUsername}`)})`);
  } else if (alert.creatorFid) {
    lines.push(`[Farcaster](${escapeUrl(`https://warpcast.com/~/profiles/${alert.creatorFid}`)})`);
  }

  return lines.join('\n');
};

// Internal send function with rate limiting
const sendMessage = async (
  text: string,
  parseMode: "MarkdownV2" | "HTML" = "HTML",
  disablePreview: boolean = true
): Promise<boolean> => {
  if (!BOT_TOKEN || !CHAT_ID) {
    return false;
  }

  return enqueueSend(async () => {
    // Rate limiting
    const now = Date.now();
    const timeSinceLastMessage = now - lastMessageTime;
    if (timeSinceLastMessage < MIN_MESSAGE_INTERVAL_MS) {
      await new Promise((r) =>
        setTimeout(r, MIN_MESSAGE_INTERVAL_MS - timeSinceLastMessage),
      );
    }
    lastMessageTime = Date.now();

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    try {
      const ok = await withRetry(
        async () => {
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: CHAT_ID,
              text,
              parse_mode: parseMode,
              disable_web_page_preview: disablePreview,
            }),
          });

          if (response.ok) {
            return true;
          }

          const errorText = await response.text();

          // Don't retry on client errors (4xx) except rate limiting (429).
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429
          ) {
            console.error(
              `[telegram] Message rejected: ${response.status} ${errorText}`,
            );
            return false;
          }

          throw new Error(
            `Telegram HTTP ${response.status}: ${errorText.slice(0, 100)}`,
          );
        },
        {
          maxRetries: 3,
          initialDelayMs: 1000,
          onRetry: (err, attempt) => {
            console.warn(
              `[telegram] Retry ${attempt}/3:`,
              err instanceof Error ? err.message : err,
            );
          },
        },
      );
      return ok;
    } catch (error) {
      console.error(
        "[telegram] Failed to send message after retries:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  });
};

export const sendTelegramAlert = async (alert: TokenAlert): Promise<boolean> => {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("[telegram] Cannot send alert - missing BOT_TOKEN or CHAT_ID");
    return false;
  }

  const message = formatTokenAlert(alert);
  const success = await sendMessage(message, "MarkdownV2", false);

  if (success) {
    console.info(`[telegram] Alert sent for ${alert.token}`);
  }

  return success;
};

export const sendSimpleMessage = async (text: string): Promise<boolean> => {
  return sendMessage(text, "HTML", true);
};

/**
 * Send an error notification to Telegram
 * Use this for critical errors that need attention
 */
export const sendErrorNotification = async (
  errorType: string,
  errorMessage: string,
  context?: Record<string, unknown>
): Promise<boolean> => {
  const lines = [
    `⚠️ <b>ERROR: ${errorType}</b>`,
    ``,
    `<code>${errorMessage}</code>`,
  ];

  if (context) {
    lines.push(``);
    lines.push(`<b>Context:</b>`);
    Object.entries(context).forEach(([key, value]) => {
      lines.push(`• ${key}: ${String(value)}`);
    });
  }

  lines.push(``);
  lines.push(`<i>${new Date().toISOString()}</i>`);

  return sendMessage(lines.join("\n"), "HTML", true);
};

/**
 * Send a status/heartbeat message
 */
export const sendStatusMessage = async (
  status: "running" | "warning" | "error",
  message: string
): Promise<boolean> => {
  const emoji = status === "running" ? "✅" : status === "warning" ? "⚠️" : "❌";
  return sendMessage(`${emoji} <b>Status:</b> ${message}`, "HTML", true);
};
