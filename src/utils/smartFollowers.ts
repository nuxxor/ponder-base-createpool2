import fs from "node:fs";
import path from "node:path";

type SmartFollowerEntry = {
  handle: string;
  twitter_url?: string;
};

type SmartFollowerCache = {
  map: Map<string, SmartFollowerEntry>;
  mtimeMs: number;
};

const normalizeHandle = (handle: string) =>
  handle.replace(/^@/, "").trim().toLowerCase();

const resolveDataPath = () => {
  const customPath = process.env.SMART_FOLLOWERS_PATH;
  if (customPath) {
    return path.isAbsolute(customPath)
      ? customPath
      : path.resolve(process.cwd(), customPath);
  }
  return path.resolve(process.cwd(), "..", "smart_followers_master.json");
};

let cache: SmartFollowerCache | null = null;

const loadSmartFollowers = (): Map<string, SmartFollowerEntry> => {
  const filePath = resolveDataPath();
  try {
    const stats = fs.statSync(filePath);
    if (cache && cache.mtimeMs === stats.mtimeMs) {
      return cache.map;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw) as {
      profiles?: SmartFollowerEntry[];
    };
    const entries = json?.profiles ?? [];
    const map = new Map<string, SmartFollowerEntry>();
    for (const entry of entries) {
      if (!entry?.handle) continue;
      map.set(normalizeHandle(entry.handle), entry);
    }
    cache = { map, mtimeMs: stats.mtimeMs };
    return map;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[smart-followers] Failed to load data from ${filePath}:`,
        (error as Error).message,
      );
    }
    cache = { map: new Map(), mtimeMs: 0 };
    return cache.map;
  }
};

export const findSmartFollower = (handle?: string) => {
  if (!handle) return null;
  const normalized = normalizeHandle(handle);
  if (!normalized) return null;
  const map = loadSmartFollowers();
  return map.get(normalized) ?? null;
};
