// modelCache.ts — TTL localStorage cache for fetched model lists (instant picker / Providers).
const PREFIX = "orchestro.models.";
const TTL = 1000 * 60 * 60; // 1h — model catalogs change rarely.

interface Entry<T> {
  at: number;
  data: T;
}

// Cached value if fresh, else fetch + cache. Errors propagate uncached so retries work.
export async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) {
      const e = JSON.parse(raw) as Entry<T>;
      if (Date.now() - e.at < TTL) return e.data;
    }
  } catch {
    /* ignore — fall through to fetch */
  }
  const data = await fetcher();
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* ignore */
  }
  return data;
}

// Synchronous read (no fetch): fresh cached value or null — init state without a loading flash.
export function peek<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) {
      const e = JSON.parse(raw) as Entry<T>;
      if (Date.now() - e.at < TTL) return e.data;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Drop a single cached list (e.g. recheck a local daemon that just started).
export function evict(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

// Drop every cached list on credential change, so a new key/account isn't served stale models.
export function clearModelCache(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
