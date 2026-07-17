// vaultStore.ts — vault-encrypted localStorage blob + in-RAM cache behind a hydrated latch,
// shared by the artifact-titles and memory stores. The latch rule: a failed decrypt (vault
// down) must NOT latch hydrated, or a later persist would clobber the real data with the
// empty cache — instead the failed load is retried on the next hydrate/persist.
import { vaultEncrypt, vaultDecrypt } from "@/shared/api/secrets";

export function createVaultStore(opts: {
  key: string;
  apply: (plain: string) => void; // decode the decrypted blob into the caller's cache (may throw)
  snapshot: () => string; // encode the caller's cache for persistence
  onHydrated?: () => void; // fired once hydration latches (even when there was nothing stored)
}) {
  let hydrated = false;
  let hydrating: Promise<void> | null = null;

  function hydrate(): Promise<void> {
    if (hydrated) return Promise.resolve();
    if (!hydrating)
      hydrating = (async () => {
        const raw = localStorage.getItem(opts.key);
        if (raw) {
          let plain: string;
          try {
            plain = await vaultDecrypt(raw);
          } catch {
            hydrating = null; // vault unavailable — don't latch; allow a retry
            return;
          }
          try {
            opts.apply(plain);
          } catch {
            /* decrypt succeeded but content is corrupt — start empty, latch below */
          }
        }
        hydrated = true;
        opts.onHydrated?.();
      })();
    return hydrating;
  }

  function persist(): void {
    if (!hydrated) {
      void hydrate(); // load failed earlier — retry rather than persist over real data
      return;
    }
    void (async () => {
      try {
        localStorage.setItem(opts.key, await vaultEncrypt(opts.snapshot()));
      } catch {
        /* quota/full — the data just won't survive reload */
      }
    })();
  }

  return { hydrate, persist };
}
