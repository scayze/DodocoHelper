/** Typed event hub for shell↔game chatter (replaces string CustomEvents on
 * `window`). Pure module: no DOM dependencies, so every tsconfig can compile
 * it. Each domain owns its hub instance: `src/leaderboard/api.ts` (name),
 * `report.ts` (win), `view.ts` (board). */

export interface EventHub<T> {
  /** Subscribe; returns an unsubscribe function. */
  on(cb: (detail: T) => void): () => void;
  /** Notify every current subscriber with a detail payload. */
  dispatch(detail: T): void;
}

export function createEventHub<T>(): EventHub<T> {
  const listeners = new Set<(detail: T) => void>();
  return {
    on(cb: (detail: T) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispatch(detail: T): void {
      for (const cb of [...listeners]) cb(detail);
    },
  };
}