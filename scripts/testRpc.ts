/**
 * Quick RPC sanity check for Base.
 *
 * Usage:
 *   # use env PONDER_RPC_URL_8453 / BASE_RPC_URL or fallback to mainnet.base.org
 *   node --import tsx/esm scripts/testRpc.ts
 *
 *   # or pass a URL explicitly
 *   node --import tsx/esm scripts/testRpc.ts https://your-base-rpc
 */

const endpoint =
  process.argv[2] ??
  process.env.PONDER_RPC_URL_8453 ??
  process.env.BASE_RPC_URL ??
  "https://mainnet.base.org";

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Non-JSON response (${res.status} ${res.statusText}): ${text.slice(0, 200)}`,
    );
  }
}

async function main() {
  console.log(`Endpoint: ${endpoint}`);
  try {
    const chainId = await rpc("eth_chainId");
    console.log("eth_chainId:", chainId);
    const blockNumber = await rpc("eth_blockNumber");
    console.log("eth_blockNumber:", blockNumber);
  } catch (err) {
    console.error("RPC error:", (err as Error).message);
    process.exit(1);
  }
}

void main();
