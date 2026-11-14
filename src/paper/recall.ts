import { V4_POOL_MANAGER } from './pools.ts';

const isV4Key = (pool: string): boolean => pool.length === 66;

/**
 * True when a route we found in this block runs through the pools of a real win. V4 pools
 * appear in recorded wins only as the shared manager address, so any V4 pool of ours counts
 * as one match for it. A single shared pool proves little, since busy pools appear in most
 * routes, so a win on two or more pools must match on at least two.
 */
export function winWasFound(winPools: string[], ourRoutes: string[][]): boolean {
  const distinct = new Set(winPools);
  const needed = Math.min(2, distinct.size);
  return ourRoutes.some((route) => {
    const matches = new Set<string>();
    for (const pool of route) {
      if (distinct.has(pool)) matches.add(pool);
      if (isV4Key(pool) && distinct.has(V4_POOL_MANAGER)) matches.add(V4_POOL_MANAGER);
    }
    return matches.size >= needed;
  });
}

export interface RecallStats {
  wins: number;
  found: number;
  retainedUsd: number;
  foundRetainedUsd: number;
}

export const newRecallStats = (): RecallStats => ({ wins: 0, found: 0, retainedUsd: 0, foundRetainedUsd: 0 });

export function addWin(stats: RecallStats, found: boolean, retainedUsd: number): void {
  stats.wins++;
  stats.retainedUsd += retainedUsd;
  if (found) {
    stats.found++;
    stats.foundRetainedUsd += retainedUsd;
  }
}
