export const AerodromeCLFactoryAbi = [
  {
    type: "event",
    name: "PoolCreated",
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "token0",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "token1",
        type: "address",
      },
      {
        indexed: true,
        internalType: "int24",
        name: "tickSpacing",
        type: "int24",
      },
      {
        indexed: false,
        internalType: "address",
        name: "pool",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "createPool",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
      { internalType: "uint24", name: "tickSpacing", type: "uint24" },
    ],
    outputs: [{ internalType: "address", name: "pool", type: "address" }],
  },
  {
    type: "function",
    name: "createPool",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
      { internalType: "int24", name: "tickSpacing", type: "int24" },
      { internalType: "uint160", name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [{ internalType: "address", name: "pool", type: "address" }],
  },
] as const;
