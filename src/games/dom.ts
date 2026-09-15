/** Shared DOM lookup for game controllers and the shell.
 *
 * Every controller previously defined its own identical `el()`; one copy
 * is enough. Throws on missing ids so mis-wired templates fail fast.
 */

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

/** Nullable variant for optional wiring (leaderboard panels). */
export function elOrNull<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
