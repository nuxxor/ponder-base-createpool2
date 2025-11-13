import {
  BASESCAN_API_KEY,
  BASESCAN_API_URL,
  BASESCAN_MIN_DELAY_MS,
  LOCK_DESTINATIONS,
} from "./constants";
import { normalizeAddress } from "./utils/address";

type BaseScanResponse<T> = {
  status?: string;
  message?: string;
  result: T;
};

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

let lastCallAt = 0;

const callBaseScan = async <T>(params: Record<string, string>): Promise<T> => {
  const now = Date.now();
  const wait = Math.max(0, BASESCAN_MIN_DELAY_MS - (now - lastCallAt));
  if (wait > 0) {
    await sleep(wait);
  }
  const url = new URL(BASESCAN_API_URL);
  url.searchParams.set("apikey", BASESCAN_API_KEY);
  url.searchParams.set("chainid", "8453");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url);
  lastCallAt = Date.now();
  if (!res.ok) {
    throw new Error(`BaseScan HTTP ${res.status}`);
  }
  const json = (await res.json()) as BaseScanResponse<T>;

  if (json.status === "0" && json.message && json.message !== "No records found") {
    throw new Error(`BaseScan error: ${json.message}`);
  }

  return json.result;
};

const decodeAddress = (hex: string): `0x${string}` | null => {
  if (!hex || hex === "0x" || hex.length < 66) return null;
  const addr = hex.slice(-40);
  return (`0x${addr}` as `0x${string}`).toLowerCase() as `0x${string}`;
};

const parseHexBigInt = (hex: string): bigint => {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
};

export const fetchContractAbi = async (address: string): Promise<string | null> => {
  const result = await callBaseScan<
    Array<{ ABI: string }>
  >({
    module: "contract",
    action: "getabi",
    address,
  });
  if (!Array.isArray(result) || result.length === 0) return null;
  const abi = result[0]?.ABI;
  if (!abi || abi === "Contract source code not verified") {
    return null;
  }
  return abi;
};

export const fetchOwnerAddress = async (
  address: string,
): Promise<`0x${string}` | null> => {
  try {
    const result = await callBaseScan<string>({
      module: "proxy",
      action: "eth_call",
      to: address,
      data: "0x8da5cb5b",
      tag: "latest",
    });

    if (!result) return null;
    const decoded =
      typeof result === "string" && result.startsWith("0x")
        ? decodeAddress(result)
        : null;
    return decoded;
  } catch (error) {
    // owner() missing or call failed
    return null;
  }
};

export const fetchTotalSupply = async (address: string): Promise<bigint> => {
  const result = await callBaseScan<string>({
    module: "proxy",
    action: "eth_call",
    to: address,
    data: "0x18160ddd",
    tag: "latest",
  });
  return parseHexBigInt(result);
};

export const fetchTokenBalance = async (
  tokenAddress: string,
  holderAddress: string,
): Promise<bigint> => {
  const result = await callBaseScan<string>({
    module: "account",
    action: "tokenbalance",
    contractaddress: tokenAddress,
    address: holderAddress,
    tag: "latest",
  });
  return BigInt(result);
};

export type LpLockReport = {
  poolAddress: string;
  lockedPercent?: number;
  lockerBreakdown: { address: string; percent: number }[];
};

export const analyzeLpLockV2 = async (
  poolAddress: string,
): Promise<LpLockReport | null> => {
  try {
    const totalSupply = await fetchTotalSupply(poolAddress);
    if (totalSupply === 0n) {
      return {
        poolAddress,
        lockedPercent: 0,
        lockerBreakdown: [],
      };
    }
    let lockedTotal = 0n;
    const breakdown: { address: string; percent: number }[] = [];

    for (const destination of LOCK_DESTINATIONS) {
      try {
        const balance = await fetchTokenBalance(poolAddress, destination);
        if (balance > 0n) {
          lockedTotal += balance;
          const percent = Number((balance * 10000n) / totalSupply) / 100;
          breakdown.push({
            address: normalizeAddress(destination),
            percent,
          });
        }
      } catch {
        // ignore failing lock target
      }
    }

    const lockedPercent =
      lockedTotal > 0n
        ? Number((lockedTotal * 10000n) / totalSupply) / 100
        : 0;

    return {
      poolAddress,
      lockedPercent,
      lockerBreakdown: breakdown,
    };
  } catch (error) {
    console.warn("[basescan] LP lock analysis failed", poolAddress, error);
    return null;
  }
};
