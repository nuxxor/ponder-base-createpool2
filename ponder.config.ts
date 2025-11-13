import { createConfig } from "ponder";
import { createPublicClient, http } from "viem";
import { base as viemBase } from "viem/chains";

import { AerodromeCLFactoryAbi } from "./abis/AerodromeCLFactoryAbi";
import { AerodromePoolFactoryAbi } from "./abis/AerodromePoolFactoryAbi";
import { UniswapV2FactoryAbi } from "./abis/UniswapV2FactoryAbi";
import { UniswapV3FactoryAbi } from "./abis/UniswapV3FactoryAbi";

const FALLBACK_START_BLOCK = 38_050_000;

const baseRpcUrl =
  process.env.PONDER_RPC_URL_8453 ??
  "https://go.getblock.io/9297461fd5214756a023f1b0c8860aef";

let dynamicStartBlock = FALLBACK_START_BLOCK;

try {
  const client = createPublicClient({
    chain: {
      ...viemBase,
      rpcUrls: {
        default: { http: [baseRpcUrl] },
        public: { http: [baseRpcUrl] },
      },
    },
    transport: http(baseRpcUrl),
  });

  const latestBlock = await client.getBlockNumber();
  dynamicStartBlock = Number(latestBlock);
  console.info(
    `[ponder-config] Using latest Base block ${dynamicStartBlock} as start block`,
  );
} catch (error) {
  console.warn(
    "[ponder-config] Failed to fetch latest Base block. Falling back to static start block.",
    error,
  );
}

export default createConfig({
  chains: {
    base: {
      id: 8453,
      rpc: baseRpcUrl,
    },
  },
  contracts: {
    UniswapV2Factory: {
      chain: "base",
      abi: UniswapV2FactoryAbi,
      address: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6",
      startBlock: dynamicStartBlock,
    },
    UniswapV3Factory: {
      chain: "base",
      abi: UniswapV3FactoryAbi,
      address: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
      startBlock: dynamicStartBlock,
    },
    AerodromeV2Factory: {
      chain: "base",
      abi: AerodromePoolFactoryAbi,
      address: "0x420dd381b31aef6683db6b902084cb0ffece40da",
      startBlock: dynamicStartBlock,
    },
    AerodromeCLFactory: {
      chain: "base",
      abi: AerodromeCLFactoryAbi,
      address: "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a",
      startBlock: dynamicStartBlock,
    },
  },
});
