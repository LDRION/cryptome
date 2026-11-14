import { hopsOf, simulateCycle } from '../executor.ts';
import { mapLimit, type Rpc } from '../rpc.ts';
import type { BlockHeader, ChainView, Proof } from './engine.ts';
import { findDynamicFeePools, readFees } from './fees.ts';
import type { Memo } from './memo.ts';
import type { PoolMeta } from './pools.ts';
import type { Cycle } from './search.ts';

/**
 * Intrinsic cost, calldata and the payment to the builder, none of which the contract can
 * see from inside its own call. Added to what it measures.
 */
export const TX_OVERHEAD_GAS = 60_000n;

const tagOf = (block: number): string => `0x${block.toString(16)}`;

/**
 * Reads moving fees and proves trades against the node. A failed read keeps the last known
 * fee, and a failed proof refuses the trade, so a network problem can only cost a missed
 * trade, never a false one.
 */
export async function createChainView(
  rpc: Rpc,
  pools: PoolMeta[],
  wrappedNative: string,
  startTag: string,
  memo?: Memo,
  /** Stored fees are a list in pool order, so each set of pools needs its own name for them. */
  feesName: string = 'fees',
  /** Reads fees past any call memory: the compact list is kept, and each raw answer is 15 KB. */
  feesRpc: Rpc = rpc,
): Promise<ChainView & { dynamicPools: number; failedRefreshes: () => number; prefetchFees: (from: number, to: number, concurrency: number) => Promise<void> }> {
  const metas = new Map(pools.map((pool) => [pool.address, pool]));
  const dynamic = await findDynamicFeePools(rpc, pools, startTag);
  let failedRefreshes = 0;

  const feesAt = (block: number): Promise<(number | null)[]> => {
    const read = (): Promise<(number | null)[]> => readFees(feesRpc, dynamic, tagOf(block));
    // Stored compactly per block rather than as raw call results, which would be many times larger.
    return memo ? memo.get(`${feesName}:${block}`, read) : read();
  };

  return {
    dynamicPools: dynamic.length,
    failedRefreshes: () => failedRefreshes,

    /** A replay reads blocks one at a time, so filling these first saves most of its wait. */
    async prefetchFees(from: number, to: number, concurrency: number) {
      const blocks = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      await mapLimit(blocks, concurrency, (block) => feesAt(block));
    },

    async refresh(header: BlockHeader, book) {
      const changed: string[] = [];
      try {
        const fees = await feesAt(header.number);
        dynamic.forEach((pool, i) => {
          const fee = fees[i];
          if (fee !== null && fee !== undefined && book.setFee(pool.address, fee)) changed.push(pool.address);
        });
      } catch {
        failedRefreshes++;
      }
      return changed;
    },

    async prove(block: number, cycle: Cycle, amountIn: bigint, pricesAtDecision: bigint[], startGap: bigint): Promise<Proof> {
      try {
        const hops = hopsOf(cycle.tokens, cycle.hops.map((hop) => hop.pool), metas, wrappedNative, pricesAtDecision);
        const result = await simulateCycle(rpc, { start: cycle.start, amountIn, hops, blockTag: tagOf(block), gap: { startGap, minGap: 0n } });
        if (!result.ok) return result;
        return { ok: true, profit: result.profit, gasUnits: result.gasUsed + TX_OVERHEAD_GAS };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
  };
}
