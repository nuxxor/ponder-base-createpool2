export const UniswapV2FactoryAbi = [
  {
    type: "event",
    name: "PairCreated",
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
        indexed: false,
        internalType: "address",
        name: "pair",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "pairCount",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "createPair",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
    ],
    outputs: [
      { internalType: "address", name: "pair", type: "address" },
    ],
  },
] as const;
