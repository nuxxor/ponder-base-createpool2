import { fetchWithRetry, type RetryOptions } from "./retry";

type ConcurrencyLimiter = <T>(task: () => Promise<T>) => Promise<T>;

const createConcurrencyLimiter = (concurrency: number): ConcurrencyLimiter => {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    activeCount -= 1;
    const resolve = queue.shift();
    if (resolve) resolve();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (activeCount >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    activeCount += 1;
    try {
      return await task();
    } finally {
      next();
    }
  };
};

const DEFAULT_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.HTTP_TIMEOUT_MS ?? 10_000),
);
const DEFAULT_HOST_CONCURRENCY = Math.max(
  1,
  Number(process.env.HTTP_HOST_CONCURRENCY ?? 8),
);

const limiterCache = new Map<string, ConcurrencyLimiter>();

const getLimiter = (key: string, concurrency: number): ConcurrencyLimiter => {
  const limiterKey = `${key}:${concurrency}`;
  const cached = limiterCache.get(limiterKey);
  if (cached) return cached;
  const limiter = createConcurrencyLimiter(concurrency);
  limiterCache.set(limiterKey, limiter);
  return limiter;
};

export type GuardedFetchOptions = RetryOptions & {
  /**
   * Override the limiter key. Defaults to `new URL(url).host`.
   */
  hostKey?: string;
  /**
   * Per-host concurrent request limit.
   */
  concurrency?: number;
  /**
   * Timeout in ms per attempt.
   */
  timeoutMs?: number;
};

export const guardedFetch = async (
  url: string | URL,
  init?: RequestInit,
  options: GuardedFetchOptions = {},
): Promise<Response> => {
  const targetUrl = typeof url === "string" ? new URL(url) : url;
  const hostKey = options.hostKey ?? targetUrl.host;
  const concurrency = Math.max(
    1,
    Number(options.concurrency ?? DEFAULT_HOST_CONCURRENCY),
  );
  const limiter = getLimiter(hostKey, concurrency);

  return limiter(() =>
    fetchWithRetry(targetUrl, init, {
      ...options,
      timeoutMs:
        options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs,
    }),
  );
};

