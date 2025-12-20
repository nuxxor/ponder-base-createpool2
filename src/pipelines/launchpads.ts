import "../env";
import { upsertNewTokenCandidate, upsertScore } from "../utils/watchlist";
import { fetchRecentClankerCandidates } from "../connectors/clanker";
import { buildZoraCandidates } from "../connectors/zora";
import { scoreClanker } from "../utils/scoring";

const EXTERNAL_REFRESH_INTERVAL_MS =
  Number(process.env.EXTERNAL_REFRESH_INTERVAL_MS) || 60 * 1000; // 1 minute for faster detection

let lastRefresh = 0;
let refreshing = false;

export const refreshExternalSources = async () => {
  if (refreshing) return;
  const now = Date.now();
  if (now - lastRefresh < EXTERNAL_REFRESH_INTERVAL_MS) {
    return;
  }
  refreshing = true;
  try {
    lastRefresh = now;

    const connectorResults = await Promise.allSettled([
      fetchRecentClankerCandidates().catch((error) => {
        console.warn("[clanker] poll failed", error);
        return [];
      }),
      buildZoraCandidates().catch((error) => {
        console.warn("[zora] poll failed", error);
        return [];
      }),
    ]);

    for (const result of connectorResults) {
      if (result.status !== "fulfilled") continue;
      const candidates = result.value ?? [];
      for (const candidate of candidates) {
        await upsertNewTokenCandidate(candidate);
        if (
          candidate.platform === "clanker" &&
          candidate.identity?.launchCount !== undefined
        ) {
          const score = scoreClanker({
            farcaster: {
              fid: candidate.identity?.creatorFid,
              developerLaunchCount: candidate.identity?.launchCount,
            },
            twitter: undefined,
          });
          await upsertScore(candidate.token.address, score);
        }
      }
    }
  } finally {
    refreshing = false;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  refreshExternalSources()
    .then(() => {
      console.info("[launchpads] refresh complete");
      process.exit(0);
    })
    .catch((error) => {
      console.error("[launchpads] refresh failed", error);
      process.exit(1);
    });
}
