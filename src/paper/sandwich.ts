import { V2_SWAP, V4_SWAP, type PoolLog } from './pools.ts';

/**
 * A sandwich pushes a price, lets a victim trade at the worse price, then pushes it back in
 * the same block. Those price moves look like arbitrage gaps, but they exist only inside
 * the attacker's own bundle: nobody else can trade in between, and they are not to be
 * pursued anyway, because they take money from the person in the middle.
 */

export interface RouteSwap {
  txHash: string;
  pool: string;
  zeroForOne: boolean;
  from: string;
  to: string;
}

/** Shared by unrelated users, so the same one on both sides says nothing about the actor. */
const PUBLIC_ROUTERS: ReadonlySet<string> = new Set([
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  '0xe592427a0aece92de3edee1f18e0157c05861564',
  '0x111111125421ca6dc452d289314280a0f8842a65',
  '0x1111111254eeb25477b68fb85ed929f73a960582',
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
]);

const word = (data: string, index: number): bigint => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);

/** Which way a swap log moved the pool. V3 logs the pool's side, V4 the swapper's. */
export function swapZeroForOne(log: PoolLog): boolean {
  const topic = log.topics[0];
  if (topic === V2_SWAP) return word(log.data, 0) > 0n;
  const amount0 = BigInt.asIntN(256, word(log.data, 0));
  return topic === V4_SWAP ? amount0 < 0n : amount0 > 0n;
}

const sameActor = (a: RouteSwap, b: RouteSwap): boolean => {
  if (a.from.toLowerCase() === b.from.toLowerCase()) return true;
  const to = a.to.toLowerCase();
  return to === b.to.toLowerCase() && !PUBLIC_ROUTERS.has(to);
};

/**
 * True when a transaction that opened or widened a gap is undone later in the block by the
 * same actor, on the same pool, in the opposite direction, with someone else in between.
 */
export function isSandwich(openers: string[], swapsInOrder: RouteSwap[]): boolean {
  for (let i = 0; i < swapsInOrder.length; i++) {
    const front = swapsInOrder[i]!;
    for (let j = i + 1; j < swapsInOrder.length; j++) {
      const back = swapsInOrder[j]!;
      if (back.pool !== front.pool || back.zeroForOne === front.zeroForOne || !sameActor(front, back)) continue;
      const between = swapsInOrder.slice(i + 1, j).some((swap) => swap.pool === front.pool && !sameActor(front, swap));
      if (!between) continue;
      const touched = openers.includes(front.txHash) || swapsInOrder.slice(i + 1, j).some((swap) => openers.includes(swap.txHash));
      if (touched) return true;
    }
  }
  return false;
}
