/** Best-effort localStorage access shared by all persistence modules.
 *
 * Every read/write silently degrades (private mode, quota, or non-DOM
 * runtimes like node:test): callers get null / no persistence instead of
 * exceptions, so no module needs its own try/catch.
 */

function store(): Storage | null {
  try {
    const s = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function storageGet(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    // Best-effort: session still works, it just doesn't persist.
  }
}

export function storageRemove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    // Best-effort.
  }
}

/** Parse a JSON payload or return null when absent/corrupt. */
export function storageReadJson(key: string): unknown {
  const raw = storageGet(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function storageWriteJson(key: string, value: unknown): void {
  try {
    storageSet(key, JSON.stringify(value));
  } catch {
    // Best-effort.
  }
}
