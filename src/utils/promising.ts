import { promises as fs } from "node:fs";
import path from "node:path";

import {
  EvaluationResult,
  TokenMetricsSnapshot,
  readWatchlist,
} from "./watchlist";
import { CommunityLinks } from "../types/community";
import { WATCH_DATA_DIR, PROMISING_TOKENS_FILE } from "../constants";

const dataDir = path.resolve(process.cwd(), WATCH_DATA_DIR);
const promisingPath = path.join(dataDir, PROMISING_TOKENS_FILE);

const ensureDataDir = async () => {
  await fs.mkdir(dataDir, { recursive: true });
};

const fileLocks = new Map<string, Promise<void>>();

const runWithFileLock = async (
  filePath: string,
  task: () => Promise<void>,
) => {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (fileLocks.get(filePath) === next) {
        fileLocks.delete(filePath);
      }
    });
  fileLocks.set(filePath, next);
  await next;
};

type PromisingMap = Record<string, PromisingToken>;

export type PromisingToken = {
  token: string;
  firstQualifiedAt: string;
  lastUpdatedAt: string;
  metrics: TokenMetricsSnapshot;
  evaluation: EvaluationResult;
  community?: CommunityLinks;
};

const readPromisingMap = async (): Promise<PromisingMap> => {
  try {
    const raw = await fs.readFile(promisingPath, "utf8");
    return prunePromisingToWatchlist(JSON.parse(raw) as PromisingMap);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await ensureDataDir();
      await fs.writeFile(
        promisingPath,
        JSON.stringify({}, null, 2) + "\n",
        "utf8",
      );
      return {};
    }
    if (error instanceof SyntaxError) {
      const backupPath = `${promisingPath}.${Date.now()}.corrupted`;
      try {
        await fs.rename(promisingPath, backupPath);
        console.warn(
          `[promising] Corrupted JSON detected. Moved ${promisingPath} -> ${backupPath}`,
        );
      } catch (renameError) {
        console.warn(
          `[promising] Failed to move corrupt file ${promisingPath}`,
          renameError,
        );
      }
      await fs.writeFile(
        promisingPath,
        JSON.stringify({}, null, 2) + "\n",
        "utf8",
      );
      return {};
    }
    throw error;
  }
};

const writePromisingMap = async (map: PromisingMap) => {
  await ensureDataDir();
  const payload = JSON.stringify(map, null, 2) + "\n";
  const tmpPath = `${promisingPath}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  await runWithFileLock(promisingPath, async () => {
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, promisingPath);
  });
};

const prunePromisingToWatchlist = async (
  map: PromisingMap,
): Promise<PromisingMap> => {
  const watchlist = await readWatchlist();
  const allowedTokens = new Set(Object.keys(watchlist.tokens));
  const removed = Object.keys(map).filter((token) => !allowedTokens.has(token));
  if (removed.length === 0) {
    return map;
  }
  for (const token of removed) {
    delete map[token];
  }
  console.warn(
    `[promising] Removed ${removed.length} token(s) missing from watchlist`,
  );
  await writePromisingMap(map);
  return map;
};

export const upsertPromisingToken = async (
  token: string,
  metrics: TokenMetricsSnapshot,
  evaluation: EvaluationResult,
) => {
  const current = await readPromisingMap();
  const existing = current[token];
  const now = new Date().toISOString();

  current[token] = {
    token,
    firstQualifiedAt: existing?.firstQualifiedAt ?? now,
    lastUpdatedAt: now,
    metrics,
    evaluation,
    community: metrics.community,
  };

  await writePromisingMap(current);
};

export const removePromisingToken = async (token: string) => {
  const current = await readPromisingMap();
  if (!(token in current)) return;
  delete current[token];
  await writePromisingMap(current);
};

export const listPromisingTokens = async (): Promise<PromisingToken[]> => {
  const current = await readPromisingMap();
  return Object.values(current);
};
