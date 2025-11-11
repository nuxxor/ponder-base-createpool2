import { ponder } from "ponder:registry";
import schema from "ponder:schema";

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

ponder.on("UniswapV2Factory:PairCreated", async ({ event, context }) => {
  const { token0, token1, pair, pairCount } = event.args;

  await savePoolCreation(
    { event, context },
    {
      protocol: "uniswap_v2",
      token0,
      token1,
      pool: pair,
      poolSequence: pairCount,
    },
  );
});

ponder.on("UniswapV3Factory:PoolCreated", async ({ event, context }) => {
  const { token0, token1, pool, fee, tickSpacing } = event.args;

  await savePoolCreation(
    { event, context },
    {
      protocol: "uniswap_v3",
      token0,
      token1,
      pool,
      feeTier: Number(fee),
      tickSpacing: Number(tickSpacing),
    },
  );
});

ponder.on("AerodromeV2Factory:PoolCreated", async ({ event, context }) => {
  const { token0, token1, pool, stable, poolId } = event.args;

  await savePoolCreation(
    { event, context },
    {
      protocol: "aerodrome_v2",
      token0,
      token1,
      pool,
      stable,
      poolSequence: poolId,
    },
  );
});

ponder.on("AerodromeCLFactory:PoolCreated", async ({ event, context }) => {
  const { token0, token1, pool, tickSpacing } = event.args;

  await savePoolCreation(
    { event, context },
    {
      protocol: "aerodrome_slipstream",
      token0,
      token1,
      pool,
      tickSpacing: Number(tickSpacing),
    },
  );
});
