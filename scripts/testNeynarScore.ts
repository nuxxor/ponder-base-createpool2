/**
 * Quick Neynar score fetcher for Farcaster FIDs.
 *
 * Usage:
 *   NEYNAR_API_KEY=... node --import tsx/esm scripts/testNeynarScore.ts 123 456
 *   # or
 *   FIDS=123,456 node --import tsx/esm scripts/testNeynarScore.ts
 */

import {
  getNeynarScoreByFid,
  getNeynarScoreByUsername,
} from "../src/clients/neynar";

type Target = { type: "fid"; fid: number } | { type: "username"; username: string };

const parseTargets = (): Target[] => {
  const args = process.argv.slice(2);
  const envTargets = (process.env.FIDS ?? process.env.USERNAMES ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const raw = [...args, ...envTargets];
  const targets: Target[] = [];
  for (const item of raw) {
    const num = Number(item);
    if (!Number.isNaN(num)) {
      targets.push({ type: "fid", fid: num });
    } else if (item) {
      targets.push({ type: "username", username: item.replace(/^@/, "") });
    }
  }
  return targets;
};

async function main() {
  const targets = parseTargets();
  if (targets.length === 0) {
    console.error(
      "Provide FIDs or usernames as args (e.g. 123 @alice) or via FIDS/USERNAMES env (comma-separated).",
    );
    process.exit(1);
  }
  for (const target of targets) {
    try {
      if (target.type === "fid") {
        const score = await getNeynarScoreByFid(target.fid);
        console.log(`fid=${target.fid} score=${score ?? "null"}`);
      } else {
        const result = await getNeynarScoreByUsername(target.username);
        console.log(
          `username=${target.username} fid=${result.fid ?? "unknown"} score=${result.score ?? "null"}`,
        );
      }
    } catch (error) {
      const label =
        target.type === "fid"
          ? `fid=${target.fid}`
          : `username=${target.username}`;
      console.error(`${label} error=${(error as Error).message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
