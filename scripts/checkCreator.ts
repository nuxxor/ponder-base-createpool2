/**
 * Quick one-off checker to inspect creator info via Zora + Neynar.
 * Usage:
 *   TARGET_ADDRESS=0x... node --import tsx/esm scripts/checkCreator.ts
 *   # or
 *   node --import tsx/esm scripts/checkCreator.ts 0x...
 *
 * Requires ZORA_API_KEY; NEYNAR_API_KEY is optional (only used if FID is returned).
 * Clanker key is NOT required here.
 */

const TARGET =
  process.env.TARGET_ADDRESS ??
  process.argv[2] ??
  "0x5a9f1c6d01a860aa5d039c1834c11a8debc2d90c";

const fetchJsonText = async (url: string, headers: Record<string, string>) => {
  const res = await fetch(url, { headers });
  const body = await res.text();
  let json: any;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON from ${url} :: ${(err as Error).message} :: body=${body.slice(0, 200)}`,
    );
  }
  return json;
};

async function fetchZoraCreator(address: string) {
  const apiKey = process.env.ZORA_API_KEY;
  if (!apiKey) throw new Error("ZORA_API_KEY missing");
  const url = new URL("https://api-sdk.zora.engineering/api/coin");
  url.searchParams.set("address", address);
  url.searchParams.set("chain", "8453");
  const json = await fetchJsonText(url.toString(), {
    "api-key": apiKey,
    Accept: "application/json",
  });
  const fc =
    json?.data?.zora20Token?.creatorProfile?.socialAccounts?.farcaster ?? null;
  return {
    farcaster: fc,
    raw: json,
  };
}

async function fetchNeynar(fid: string | number) {
  const apiKey = process.env.NEYNAR_API_KEY;
  if (!apiKey) throw new Error("NEYNAR_API_KEY missing");
  const url = new URL("https://api.neynar.com/v2/farcaster/user/bulk");
  url.searchParams.set("fids", String(fid));
  return fetchJsonText(url.toString(), {
    "x-api-key": apiKey,
    Accept: "application/json",
  });
}

async function main() {
  const addr = TARGET.toLowerCase();
  console.log("checking:", addr);

  try {
    const zora = await fetchZoraCreator(addr);
    console.log("zora farcaster:", zora.farcaster ?? "none");

    const fid = zora.farcaster?.id ?? zora.farcaster?.fid;
    if (fid) {
      try {
        const neynar = await fetchNeynar(fid);
        console.log("neynar user:", neynar?.users?.[0] ?? "none");
      } catch (err) {
        console.error("neynar error:", (err as Error).message);
      }
    } else {
      console.log("no FID from Zora, skipping Neynar");
    }
  } catch (err) {
    console.error("zora error:", (err as Error).message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
