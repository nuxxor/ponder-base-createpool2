/**
 * Simple LRU Cache with TTL support
 * Prevents memory leaks in long-running processes
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LRUCache<K, V> {
  private cache: Map<K, CacheEntry<V>>;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number = 1000, ttlMs: number = 3600000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V, customTtlMs?: number): void {
    // If key exists, delete it first (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (customTtlMs ?? this.ttlMs),
    });
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Remove all expired entries
   * Call this periodically if you want proactive cleanup
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    this.cache.forEach((entry, key) => {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        pruned++;
      }
    });

    return pruned;
  }

  /**
   * Get cache statistics
   */
  stats(): { size: number; maxSize: number; ttlMs: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
    };
  }
}

/**
 * Create a memoized async function with LRU caching
 *
 * @example
 * const memoizedFetch = memoizeAsync(
 *   (userId: number) => fetchUser(userId),
 *   { maxSize: 100, ttlMs: 60000 }
 * );
 */
export function memoizeAsync<K, V>(
  fn: (key: K) => Promise<V>,
  options: { maxSize?: number; ttlMs?: number } = {}
): (key: K) => Promise<V> {
  const cache = new LRUCache<K, Promise<V>>(options.maxSize, options.ttlMs);

  return async (key: K): Promise<V> => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const promise = fn(key);
    cache.set(key, promise);

    // If the promise rejects, remove it from cache
    promise.catch(() => {
      cache.delete(key);
    });

    return promise;
  };
}
