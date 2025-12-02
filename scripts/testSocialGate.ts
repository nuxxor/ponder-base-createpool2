import assert from "node:assert/strict";

process.env.SKIP_ENV_FILES = "true";
process.env.PROMISING_TWITTER_MIN_FOLLOWERS = "100";
process.env.PROMISING_FARCASTER_MIN_FOLLOWERS = "200";
process.env.PROMISING_CREATOR_MIN_FOLLOWERS = "300";
process.env.TWITTER_API_KEY = process.env.TWITTER_API_KEY ?? "test-key";
process.env.CLANKER_API_KEY = "test-clanker";
process.env.NEYNAR_API_KEY = "test-neynar";
process.env.ZORA_API_KEY = "test-zora";
process.env.MIN_NEYNAR_SCORE = "0.55";
process.env.SMART_FOLLOWER_AUTO_RUN = "false";

type JsonResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
};

const createResponse = (data: any): JsonResponse => ({
  ok: true,
  status: 200,
  json: async () => data,
});

const followerMap: Record<string, number> = {
  nohandle: 0,
  lowhandle: 50,
  passhandle: 1000,
};

const farcasterMap: Record<string, number> = {
  "42": 50,
  "43": 500,
};

const neynarScoreMap: Record<string, number> = {
  "42": 0.3,
  "43": 0.9,
};

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("twitterapi.io")) {
    const handle = new URL(url).searchParams.get("userName") ?? "";
    const followers = followerMap[handle] ?? 0;
    return createResponse({ data: { followers } });
  }
  if (url.includes("api.farcaster.xyz")) {
    const fid = new URL(url).searchParams.get("fid") ?? "";
    const followers = farcasterMap[fid] ?? 0;
    return createResponse({ result: { user: { followerCount: followers } } });
  }
  if (url.includes("clanker.world")) {
    return createResponse({
      data: {
        requestor_fid: 43,
        social_context: { platform: "Farcaster" },
        msg_sender: "0xabc",
      },
    });
  }
  if (url.includes("api.neynar.com")) {
    if (url.includes("/v2/farcaster/user/bulk")) {
      const fid = new URL(url).searchParams.get("fids") ?? "";
      const score = neynarScoreMap[fid] ?? null;
      return createResponse({ users: [{ fid: Number(fid), score }] });
    }
    return createResponse({
      users: [
        {
          follower_count: 1000,
          username: "creator",
          verified_addresses: { eth_addresses: ["0xabc"] },
        },
      ],
    });
  }
  if (url.includes("api-sdk.zora.engineering")) {
    return createResponse({
      data: {
        zora20Token: {
          creatorProfile: {
            socialAccounts: {
              farcaster: {
                id: 43,
                username: "creator",
                followerCount: 1200,
              },
            },
          },
        },
      },
    });
  }
  throw new Error(`Unhandled fetch for ${url}`);
}) as any;

const { enforcePromisingSocialGate } = await import("../src/utils/socialProof");

type MinimalEntry = {
  token: string;
  community?: { twitter?: string };
  identity?: { platform?: string; creatorFid?: number };
};

const wrapEntry = (entry: MinimalEntry) => ({
  token: entry.token,
  status: "active" as const,
  firstSeen: new Date().toISOString(),
  pools: [],
  quoteTokens: [],
  community: entry.community,
  identity: entry.identity,
});

const missingHandle = wrapEntry({ token: "0xmissing" });
const missingResult = await enforcePromisingSocialGate(missingHandle as any);
assert.equal(missingResult.passes, false);
assert.ok(missingResult.reasons.includes("Twitter handle missing"));

const lowHandle = wrapEntry({
  token: "0xlow",
  community: { twitter: "https://twitter.com/lowhandle" },
});
const lowResult = await enforcePromisingSocialGate(lowHandle as any);
assert.equal(lowResult.passes, false);
assert.ok(lowResult.reasons.includes("Twitter followers 50 < 100"));
assert.equal(lowResult.stats.twitter?.handle, "lowhandle");
assert.equal(lowResult.stats.twitter?.followers, 50);

const farcasterFail = wrapEntry({
  token: "0xfarcasterFail",
  community: { twitter: "https://twitter.com/passhandle" },
  identity: { platform: "clanker", creatorFid: 42 },
});
const farcasterResult = await enforcePromisingSocialGate(farcasterFail as any);
assert.equal(farcasterResult.passes, false);
assert.ok(farcasterResult.reasons.includes("Farcaster followers 50 < 200"));

const passEntry = wrapEntry({
  token: "0xpass",
  community: { twitter: "https://twitter.com/passhandle" },
  identity: { platform: "clanker", creatorFid: 43 },
});
const passResult = await enforcePromisingSocialGate(passEntry as any);
assert.equal(passResult.passes, true);
assert.equal(passResult.stats.twitter?.handle, "passhandle");
assert.equal(passResult.stats.twitter?.followers, 1000);

const identityHandle = wrapEntry({
  token: "0xidentity",
  identity: { twitter: "@passhandle", creatorFid: 43 },
});
const identityResult = await enforcePromisingSocialGate(identityHandle as any);
assert.equal(identityResult.passes, true);
assert.equal(identityResult.stats.twitter?.handle, "passhandle");

console.log("[social-gate:test] All scenarios passed");
