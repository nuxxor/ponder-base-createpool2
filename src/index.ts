import { ponder } from "ponder:registry";
import schema from "ponder:schema";

import { BASE_ANCHOR_TOKENS, VIRTUAL_TOKEN_ADDRESS } from "./constants";
import { normalizeAddress } from "./utils/address";
import {
  trackTokenCandidate,
  upsertNewTokenCandidate,
} from "./utils/watchlist";

const ENABLE_POOL_TRACKING =
  String(process.env.ENABLE_POOL_TRACKING ?? "false").toLowerCase() === "true";

type PoolCreationExtras = {
  protocol: string;
  token0: `0x${string}`;
  token1: `0x${string}`;
  pool: `0x${string}`;
  stable?: boolean | null;
  feeTier?: number | null;
  tickSpacing?: number | null;
  poolSequence?: bigint | number | null;
};

type HandlerArgs = Parameters<
  Parameters<(typeof ponder)["on"]>[1]
>[0];

const savePoolCreation = async (
  { event, context }: HandlerArgs,
  extras: PoolCreationExtras,
) => {
  await context.db.insert(schema.poolCreation).values({
    id: event.id,
    protocol: extras.protocol,
    factoryAddress: event.log.address,
    transactionHash: event.transaction.hash,
    blockNumber: Number(event.block.number),
    blockTimestamp: Number(event.block.timestamp),
    logIndex: Number(event.log.logIndex),
    token0: extras.token0,
    token1: extras.token1,
    poolAddress: extras.pool,
    stable: extras.stable ?? null,
    feeTier: extras.feeTier ?? null,
    tickSpacing: extras.tickSpacing ?? null,
    poolSequence:
      extras.poolSequence === undefined || extras.poolSequence === null
        ? null
        : BigInt(extras.poolSequence),
  });
};

const detectNovelToken = (
  token0: `0x${string}`,
  token1: `0x${string}`,
):
  | {
      novel: `0x${string}`;
      quote: `0x${string}`;
      anchor: `0x${string}`;
    }
  | undefined => {
  const t0 = normalizeAddress(token0);
  const t1 = normalizeAddress(token1);
  const token0IsAnchor = BASE_ANCHOR_TOKENS.has(t0);
  const token1IsAnchor = BASE_ANCHOR_TOKENS.has(t1);

  if (token0IsAnchor && !token1IsAnchor) {
    return { novel: token1, quote: token0, anchor: token0 };
  }

  if (token1IsAnchor && !token0IsAnchor) {
    return { novel: token0, quote: token1, anchor: token1 };
  }

  return undefined;
};

const maybeTrackNovelToken = async (
  params: PoolCreationExtras & {
    event: HandlerArgs["event"];
  },
) => {
  if (!ENABLE_POOL_TRACKING) {
    return;
  }
  const candidate = detectNovelToken(params.token0, params.token1);
  if (!candidate) return;

  await trackTokenCandidate({
    tokenAddress: candidate.novel,
    quoteTokenAddress: candidate.quote,
    poolAddress: params.pool,
    protocol: params.protocol,
    factoryAddress: params.event.log.address,
    blockNumber: Number(params.event.block.number),
    blockTimestamp: Number(params.event.block.timestamp),
  });

  if (
    VIRTUAL_TOKEN_ADDRESS &&
    candidate.anchor === VIRTUAL_TOKEN_ADDRESS &&
    params.event.block.timestamp
  ) {
    const lpTime = new Date(
      Number(params.event.block.timestamp) * 1000,
    ).toISOString();
    await upsertNewTokenCandidate({
      platform: "virtuals",
      identity: { platform: "virtuals" },
      token: {
        chainId: 8453,
        address: candidate.novel,
        quote: candidate.quote,
        poolAddress: params.pool,
        factory: params.event.log.address as `0x${string}`,
        createdAt: lpTime,
      },
      schedule: { lpDeployedAt: lpTime, source: "virtuals" },
    });
  }
};

ponder.on("UniswapV2Factory:PairCreated", async ({ event, context }) => {
  const { token0, token1, pair, pairCount } = event.args;

  const payload: PoolCreationExtras = {
    protocol: "uniswap_v2",
    token0,
    token1,
    pool: pair,
    poolSequence: pairCount,
  };

  await savePoolCreation({ event, context }, payload);
  await maybeTrackNovelToken({ ...payload, event });
});

ponder.on("UniswapV3Factory:PoolCreated", async ({ event, context }) => {
  const { token0, token1, pool, fee, tickSpacing } = event.args;

  const payload: PoolCreationExtras = {
    protocol: "uniswap_v3",
    token0,
    token1,
    pool,
    feeTier: Number(fee),
    tickSpacing: Number(tickSpacing),
  };

  await savePoolCreation({ event, context }, payload);
  await maybeTrackNovelToken({ ...payload, event });
});

ponder.on("AerodromeV2Factory:PoolCreated", async ({ event, context }) => {
  const { token0, token1, pool, stable, poolId } = event.args;

  const payload: PoolCreationExtras = {
    protocol: "aerodrome_v2",
    token0,
    token1,
    pool,
    stable,
    poolSequence: poolId,
  };

  await savePoolCreation({ event, context }, payload);
  await maybeTrackNovelToken({ ...payload, event });
});

ponder.on("AerodromeCLFactory:PoolCreated", async ({ event, context }) => {
  const { token0, token1, pool, tickSpacing } = event.args;

  const payload: PoolCreationExtras = {
    protocol: "aerodrome_slipstream",
    token0,
    token1,
    pool,
    tickSpacing: Number(tickSpacing),
  };

  await savePoolCreation({ event, context }, payload);
  await maybeTrackNovelToken({ ...payload, event });
});
