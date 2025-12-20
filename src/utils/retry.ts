/**
 * Retry utility with exponential backoff
 * Use this for all external API calls to handle transient failures
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "shouldRetry" | "onRetry">> = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

export class RetryError extends Error {
  public readonly attempts: number;
  public readonly lastError: unknown;

  constructor(message: string, attempts: number, lastError: unknown) {
    super(message);
    this.name = "RetryError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Execute a function with automatic retry and exponential backoff
 *
 * @example
 * const result = await withRetry(
 *   () => fetch('https://api.example.com/data'),
 *   { maxRetries: 3, initialDelayMs: 1000 }
 * );
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier,
  } = { ...DEFAULT_OPTIONS, ...options };

  const shouldRetry = options.shouldRetry ?? (() => true);
  const onRetry = options.onRetry ?? (() => {});

  let lastError: unknown;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !shouldRetry(error)) {
        throw new RetryError(
          `Failed after ${attempt + 1} attempts: ${error instanceof Error ? error.message : String(error)}`,
          attempt + 1,
          lastError
        );
      }

      onRetry(error, attempt + 1, delay);
      await sleep(delay);
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  // Should never reach here, but TypeScript needs this
  throw new RetryError(`Failed after ${maxRetries + 1} attempts`, maxRetries + 1, lastError);
}

/**
 * Execute a fetch request with automatic retry
 * Handles common HTTP error codes appropriately
 *
 * @example
 * const response = await fetchWithRetry('https://api.example.com/data', {
 *   headers: { 'Authorization': 'Bearer token' }
 * });
 */
export async function fetchWithRetry(
  url: string | URL,
  init?: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => {
    // Retry on network errors
    if (error instanceof TypeError) return true;
    // Don't retry on other errors by default
    return false;
  });

  return withRetry(
    async () => {
      const response = await fetch(url, init);

      // Retry on server errors (5xx) and rate limits (429)
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    },
    { ...options, shouldRetry }
  );
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a retry wrapper with pre-configured options
 * Useful for creating API-specific retry functions
 *
 * @example
 * const neynarRetry = createRetryWrapper({
 *   maxRetries: 3,
 *   onRetry: (err, attempt) => console.log(`Neynar retry ${attempt}`)
 * });
 *
 * const result = await neynarRetry(() => fetchNeynarScore(fid));
 */
export function createRetryWrapper(defaultOptions: RetryOptions) {
  return <T>(fn: () => Promise<T>, overrideOptions?: RetryOptions): Promise<T> => {
    return withRetry(fn, { ...defaultOptions, ...overrideOptions });
  };
}

/**
 * Exponential backoff delay calculator
 * Returns delay in ms for a given attempt number
 */
export function calculateBackoff(
  attempt: number,
  initialDelayMs: number = 500,
  maxDelayMs: number = 10000,
  multiplier: number = 2
): number {
  const delay = initialDelayMs * Math.pow(multiplier, attempt);
  return Math.min(delay, maxDelayMs);
}
