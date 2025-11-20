/**
 * Lists recent Zora20 coins from the ZoraFactory on Base.
 *
 * Usage:
 *   # last 50k blocks (default) using PONDER_RPC_URL_8453 or BASE_RPC_URL
 *   node --import tsx/esm scripts/listZoraCoins.ts
 *
 *   # custom window
 *   BLOCK_WINDOW=100000 node --import tsx/esm scripts/listZoraCoins.ts
 *
 * Output: event name, coin address, name, symbol.
 *
 * Requires: env RPC (PONDER_RPC_URL_8453 or BASE_RPC_URL). Uses viem (already in deps).
 */

import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import { base } from "viem/chains";

const FACTORY = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as const; // ZoraFactory on Base
const BLOCK_WINDOW = BigInt(Number(process.env.BLOCK_WINDOW ?? 50_000));
const LOG_RANGE = BigInt(Number(process.env.LOG_RANGE ?? 8)); // free-tier friendly (Alchemy free: 10 block max)

// Uniswap v4 PoolKey tuple cannot be parsed by parseAbi directly; use minimal ABI without tuple
const abi = parseAbi([
  "event CoinCreatedV4(address indexed caller,address indexed payoutRecipient,address indexed platformReferrer,address currency,string uri,string name,string symbol,address coin,address poolKeyHash,string version)",
  "event CreatorCoinCreated(address indexed caller,address indexed payoutRecipient,address indexed platformReferrer,address currency,string uri,string name,string symbol,address coin,address poolKeyHash,string version)",
  "event CoinCreated(address indexed caller,address indexed payoutRecipient,address indexed platformReferrer,address currency,string uri,string name,string symbol,address coin,address pool,string version)",
]);

const transport = http(
  process.env.PONDER_RPC_URL_8453 ??
    process.env.BASE_RPC_URL ??
    "https://base.rpc.blxrbdn.com",
);

const client = createPublicClient({
  chain: base,
  transport,
});

async function main() {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > BLOCK_WINDOW ? latest - BLOCK_WINDOW : 0n;
  console.log(
    `Scanning ZoraFactory ${FACTORY} from block ${fromBlock} to ${latest} (window=${BLOCK_WINDOW})`,
  );

const eventNames = ["CreatorCoinCreated", "CoinCreatedV4", "CoinCreated"] as const;

async function scanEvent(ev: (typeof eventNames)[number]) {
  const abiEvent = abi.find((x) => "name" in x && x.name === ev);
  if (!abiEvent) return;
  let cursor = fromBlock;
  while (cursor <= latest) {
    const end = cursor + LOG_RANGE - 1n > latest ? latest : cursor + LOG_RANGE - 1n;
    try {
      const logs = await client.getLogs({
        address: FACTORY,
        fromBlock: cursor,
        toBlock: end,
        event: abiEvent as any,
      });
      logs.forEach((log) => {
        const parsed = decodeEventLog({
          abi,
          data: log.data,
          topics: log.topics,
        });
        const args: any = parsed.args;
        console.log(
          `${ev}: coin=${args.coin} name=${args.name} symbol=${args.symbol}`,
        );
      });
    } catch (err) {
      console.error(
        `[${ev}] failed for range [${cursor}, ${end}]: ${(err as Error).message}`,
      );
    }
    cursor = end + 1n;
  }
}

await Promise.all(eventNames.map((ev) => scanEvent(ev)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
