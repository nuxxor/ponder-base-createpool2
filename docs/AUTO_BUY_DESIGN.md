# Auto-Buy Module Design

## Overview

Auto-buy modülü, sniper bot'un onayladığı tokenleri otomatik olarak satın alır. İki farklı DEX protokolü desteklenir:

- **Clanker tokens**: Uniswap V3 pools
- **Zora tokens**: Uniswap V4 pools (hooks ile)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SNIPER BOT                               │
│                                                                   │
│  Token Detected → Validation → Pass? ─┬─→ Telegram Alert         │
│                                        │                          │
│                                        └─→ AUTO-BUY MODULE        │
│                                             │                     │
│                              ┌──────────────┴──────────────┐      │
│                              ▼                             ▼      │
│                     ┌───────────────┐            ┌───────────────┐│
│                     │   Clanker     │            │     Zora      ││
│                     │  (Uniswap V3) │            │ (Uniswap V4)  ││
│                     └───────┬───────┘            └───────┬───────┘│
│                             │                            │        │
│                             └──────────────┬─────────────┘        │
│                                            ▼                      │
│                              ┌─────────────────────────┐          │
│                              │   WALLET (Private Key)  │          │
│                              │   ETH → Token Swap      │          │
│                              └─────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

## Contract Addresses (Base Mainnet)

### Uniswap V3 (Clanker)
| Contract | Address |
|----------|---------|
| SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| UniversalRouter | `0x6fF5693b99212Da76ad316178A184AB56D299b43` |
| QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |
| UniswapV3Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |

### Uniswap V4 (Zora)
| Contract | Address |
|----------|---------|
| PoolManager | `0x7Da1D65F8B249183667cdE74C5CBD46dD38AA829` |
| UniversalRouter (V4) | TBD - Check Zora docs |
| Zora Hook | From pool creation event |

### Tokens
| Token | Address |
|-------|---------|
| WETH | `0x4200000000000000000000000000000000000006` |
| USDC | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |

## Configuration

```bash
# .env.local

# Auto-buy wallet (KEEP SECRET!)
AUTOBUY_PRIVATE_KEY=0x...

# Buy settings
AUTOBUY_ENABLED=true
AUTOBUY_AMOUNT_ETH=0.01          # ETH per trade
AUTOBUY_MAX_DAILY_ETH=0.5        # Daily limit
AUTOBUY_SLIPPAGE_PERCENT=10      # 10% slippage for memecoins
AUTOBUY_GAS_PRIORITY_GWEI=0.1    # Priority fee

# Safety
AUTOBUY_MIN_LIQUIDITY_USD=5000   # Min liquidity before buy
AUTOBUY_REQUIRE_TELEGRAM=true    # Wait for Telegram alert success
```

## Module Structure

```
src/
├── services/
│   ├── autobuy.ts           # Main auto-buy service
│   ├── wallet.ts            # Wallet management
│   └── telegram.ts          # (existing)
├── swap/
│   ├── uniswapV3.ts         # V3 swap implementation (Clanker)
│   ├── uniswapV4.ts         # V4 swap implementation (Zora)
│   └── types.ts             # Swap types
└── sniper.ts                # Integration point
```

## Implementation Details

### 1. Wallet Service (`src/services/wallet.ts`)

```typescript
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

export class WalletService {
  private account;
  private client;

  constructor(privateKey: string) {
    this.account = privateKeyToAccount(privateKey as `0x${string}`);
    this.client = createWalletClient({
      account: this.account,
      chain: base,
      transport: http(process.env.PONDER_RPC_URL_8453),
    });
  }

  async getBalance(): Promise<bigint> { ... }
  async signTransaction(tx): Promise<string> { ... }
  async sendTransaction(tx): Promise<string> { ... }
}
```

### 2. Uniswap V3 Swap (`src/swap/uniswapV3.ts`)

```typescript
interface SwapParams {
  tokenIn: string;      // WETH
  tokenOut: string;     // Token address
  amountIn: bigint;     // ETH amount in wei
  slippage: number;     // 0.1 = 10%
  recipient: string;    // Wallet address
  deadline: number;     // Unix timestamp
}

async function swapExactInputSingle(params: SwapParams): Promise<string> {
  // 1. Quote expected output
  const quotedAmount = await quoter.quoteExactInputSingle(...);

  // 2. Calculate minimum output with slippage
  const amountOutMinimum = quotedAmount * (1 - slippage);

  // 3. Build swap transaction
  const swapParams = {
    tokenIn: WETH,
    tokenOut: params.tokenOut,
    fee: 10000,  // 1% fee tier (common for memecoins)
    recipient: params.recipient,
    amountIn: params.amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  };

  // 4. Execute swap via SwapRouter02
  const txHash = await swapRouter.exactInputSingle(swapParams);
  return txHash;
}
```

### 3. Uniswap V4 Swap (`src/swap/uniswapV4.ts`)

Zora coinleri V4 kullanıyor. Swap için:

```typescript
// Zora V4 swap - poolKey kullanarak
interface ZoraSwapParams {
  coin: string;           // Zora coin address
  poolKey: {
    currency: string;
    token0: string;
    fee: number;
    tickSpacing: number;
    hooks: string;        // Zora hook address
  };
  amountIn: bigint;
  slippage: number;
}

async function swapZoraCoin(params: ZoraSwapParams): Promise<string> {
  // V4 uses PoolManager directly with swap() function
  // Or use UniversalRouter V4 commands

  // Option 1: Direct PoolManager swap
  // Option 2: Zora SDK (if available)
  // Option 3: UniversalRouter with V4 commands
}
```

### 4. Auto-Buy Service (`src/services/autobuy.ts`)

```typescript
interface AutoBuyConfig {
  enabled: boolean;
  amountEth: number;
  maxDailyEth: number;
  slippagePercent: number;
  minLiquidityUsd: number;
}

interface TradeResult {
  success: boolean;
  txHash?: string;
  tokenAmount?: bigint;
  ethSpent?: bigint;
  error?: string;
}

class AutoBuyService {
  private config: AutoBuyConfig;
  private wallet: WalletService;
  private dailySpent: number = 0;
  private lastResetDate: string;

  async executeBuy(
    token: TokenInfo,
    platform: "clanker" | "zora",
    poolAddress?: string
  ): Promise<TradeResult> {
    // 1. Check daily limit
    if (this.dailySpent >= this.config.maxDailyEth) {
      return { success: false, error: "Daily limit reached" };
    }

    // 2. Check wallet balance
    const balance = await this.wallet.getBalance();
    if (balance < parseEther(this.config.amountEth.toString())) {
      return { success: false, error: "Insufficient balance" };
    }

    // 3. Execute swap based on platform
    let result: TradeResult;
    if (platform === "clanker") {
      result = await this.swapV3(token);
    } else {
      result = await this.swapV4(token);
    }

    // 4. Update tracking
    if (result.success) {
      this.dailySpent += this.config.amountEth;
      await this.logTrade(token, result);
    }

    return result;
  }
}
```

### 5. Integration into Sniper

```typescript
// sniper.ts modifications

import { autoBuyService } from "./services/autobuy";

// In sendLiquidityAlert():
async function sendLiquidityAlert(token, creatorInfo, liquidity, metrics) {
  // ... existing telegram alert code ...

  // Execute auto-buy if enabled
  if (AUTOBUY_ENABLED && liquidity >= MIN_LIQUIDITY_USD) {
    const buyResult = await autoBuyService.executeBuy(
      token,
      token.platform,
      token.poolAddress
    );

    if (buyResult.success) {
      await sendTelegramMessage(`✅ AUTO-BUY: ${token.symbol}\n` +
        `TX: ${buyResult.txHash}\n` +
        `Spent: ${buyResult.ethSpent} ETH`);
    } else {
      await sendTelegramMessage(`❌ AUTO-BUY FAILED: ${buyResult.error}`);
    }
  }
}

// For big accounts (instant buy, no liquidity check):
if (twitterFollowers >= MIN_TWITTER_FOLLOWERS) {
  await sendLiquidityAlert(token, creatorInfo, 0, {});

  // INSTANT BUY for big accounts
  if (AUTOBUY_ENABLED && AUTOBUY_INSTANT_BIG_ACCOUNTS) {
    await autoBuyService.executeBuy(token, token.platform);
  }
}
```

## Trade Flow

```
1. Token Detected (Clanker/Zora event)
   │
2. Validation Passes (Twitter/Farcaster/Neynar)
   │
3. Check Trade Conditions
   ├─ Daily limit OK?
   ├─ Wallet balance OK?
   ├─ Liquidity >= $5K? (or big account = skip)
   │
4. Determine Pool & Protocol
   ├─ Clanker → Find V3 pool (WETH pair, 1% fee)
   └─ Zora → Use poolKey from event
   │
5. Quote Expected Output
   │
6. Calculate Minimum Output (with slippage)
   │
7. Execute Swap
   ├─ Approve WETH (if needed)
   └─ Call exactInputSingle()
   │
8. Verify Transaction
   │
9. Log Trade & Send Telegram
```

## Risk Management

### Slippage Protection
- Default 10% for memecoins (volatile)
- Quote before swap to get expected output
- Revert if actual output < expected * (1 - slippage)

### Daily Limits
```typescript
AUTOBUY_MAX_DAILY_ETH=0.5  // Max 0.5 ETH per day
```

### Position Size
```typescript
AUTOBUY_AMOUNT_ETH=0.01    // 0.01 ETH per trade (~$25)
```

### Honeypot Detection (Future)
- Check if token is sellable before buying
- Simulate sell transaction
- Check for unusual tax/fees

### Gas Protection
- Use priority fee for faster execution
- Set reasonable gas limit
- Abort if gas > threshold

## Telegram Notifications

```
✅ AUTO-BUY EXECUTED

Token: 0x1234...abcd
Symbol: $EXAMPLE
Platform: clanker

💰 Trade:
• Spent: 0.01 ETH
• Received: 1,234,567 tokens
• Price: $0.000025

⛽ Gas: 0.0005 ETH
🔗 TX: basescan.org/tx/0x...
```

## Testing Checklist

1. [ ] Test with 0.001 ETH first
2. [ ] Verify V3 swap works (Clanker token)
3. [ ] Verify V4 swap works (Zora token)
4. [ ] Test slippage protection (reject bad trades)
5. [ ] Test daily limit enforcement
6. [ ] Test insufficient balance handling
7. [ ] Test Telegram notifications
8. [ ] Test with real token detection flow

## Security Considerations

1. **Private Key**: Never commit, use .env.local
2. **RPC**: Use local node for speed + privacy
3. **Approvals**: Only approve exact amount needed
4. **Validation**: Double-check token address from event
5. **Limits**: Enforce daily spending limits

## Future Enhancements

- [ ] Multi-wallet rotation
- [ ] Auto-sell on profit target
- [ ] Trailing stop-loss
- [ ] Portfolio tracking dashboard
- [ ] Honeypot pre-check
- [ ] MEV protection (private mempool)
