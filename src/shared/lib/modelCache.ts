// modelCache.ts — TTL localStorage cache for fetched model lists, so the chat
// picker and Providers screen serve instantly instead of re-fetching every open.
const PREFIX = "orchestro.models.";
const TTL = 1000 * 60 * 60; // 1h — model catalogs change rarely.

interface Entry<T> {
  at: number;
  data: T;
}

// Returns the cached value if present and still fresh, else runs the fetcher,
// caches its result, and returns it. Errors propagate uncached so retries work.
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

// Synchronous read: the cached value if present and still fresh, else null.
// No fetch — lets a component initialize state from cache without a loading flash.
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

// Drop every cached list — call when credentials change so a new key/account
// doesn't serve the previous one's models.
export function clearModelCache(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
