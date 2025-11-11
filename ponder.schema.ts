import { onchainTable } from "ponder";

export const poolCreation = onchainTable("pool_creation", (t) => ({
  id: t.text().primaryKey(),
  protocol: t.text().notNull(),
  factoryAddress: t.hex().notNull(),
  transactionHash: t.hex().notNull(),
  blockNumber: t.integer().notNull(),
  blockTimestamp: t.integer().notNull(),
  logIndex: t.integer().notNull(),
  token0: t.hex().notNull(),
  token1: t.hex().notNull(),
  poolAddress: t.hex().notNull(),
  stable: t.boolean(),
  feeTier: t.integer(),
  tickSpacing: t.integer(),
  poolSequence: t.bigint(),
}));
