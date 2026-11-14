import { encodeFunctionData, parseAbi } from 'viem';
import type { Depth, TickEntry } from '../amm.ts';
import type { Rpc } from '../rpc.ts';
import { multicall, type Call } from './multicall.ts';
import type { PoolBook, PoolMeta } from './pools.ts';

const V4_STATE_VIEW = '0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
const WORDS_EACH_SIDE = 1;
const WORD_BITS = 256;

const V3_ABI = parseAbi([
  'function tickBitmap(int16) view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet)',
]);
const V4_ABI = parseAbi([
  'function getTickBitmap(bytes32, int16) view returns (uint256)',
  'function getTickLiquidity(bytes32, int24) view returns (uint128 liquidityGross, int128 liquidityNet)',
]);

/** The bitmap word holding a tick, as pools group compressed ticks into 256-bit words. */
export const wordOfTick = (tick: number, spacing: number): number => Math.floor(Math.floor(tick / spacing) / WORD_BITS);

/** Ticks marked as initialized in one bitmap word. */
export function ticksInWord(word: bigint, wordPos: number, spacing: number): number[] {
  const ticks: number[] = [];
  for (let bit = 0; bit < WORD_BITS; bit++) {
    if ((word >> BigInt(bit)) & 1n) ticks.push((wordPos * WORD_BITS + bit) * spacing);
  }
  return ticks;
}

const bitmapCall = (pool: PoolMeta, wordPos: number): Call =>
  pool.kind === 'v4'
    ? { target: V4_STATE_VIEW, allowFailure: true, callData: encodeFunctionData({ abi: V4_ABI, functionName: 'getTickBitmap', args: [pool.address as `0x${string}`, wordPos] }) }
    : { target: pool.address as `0x${string}`, allowFailure: true, callData: encodeFunctionData({ abi: V3_ABI, functionName: 'tickBitmap', args: [wordPos] }) };

const tickCall = (pool: PoolMeta, tick: number): Call =>
  pool.kind === 'v4'
    ? { target: V4_STATE_VIEW, allowFailure: true, callData: encodeFunctionData({ abi: V4_ABI, functionName: 'getTickLiquidity', args: [pool.address as `0x${string}`, tick] }) }
    : { target: pool.address as `0x${string}`, allowFailure: true, callData: encodeFunctionData({ abi: V3_ABI, functionName: 'ticks', args: [tick] }) };

/**
 * Reads which ticks hold liquidity around each pool's current price, in one batched call,
 * at the given block so that a replay sees the depth that block really had.
 */
export async function loadDepths(rpc: Rpc, pools: PoolMeta[], book: PoolBook, blockTag: string = 'latest'): Promise<{ loaded: number; skipped: number }> {
  const targets: { pool: PoolMeta; words: number[]; center: number }[] = [];
  let skipped = 0;
  for (const pool of pools) {
    if (pool.kind === 'v2') continue;
    const tick = book.tickOf(pool.address);
    if (tick === null || pool.tickSpacing <= 0) {
      skipped++;
      continue;
    }
    const center = wordOfTick(tick, pool.tickSpacing);
    const words = Array.from({ length: WORDS_EACH_SIDE * 2 + 1 }, (_, i) => center - WORDS_EACH_SIDE + i);
    targets.push({ pool, words, center });
  }

  const bitmapCalls = targets.flatMap(({ pool, words }) => words.map((word) => bitmapCall(pool, word)));
  const bitmaps = await multicall(rpc, bitmapCalls, blockTag);

  let cursor = 0;
  const tickRequests: { target: (typeof targets)[number]; ticks: number[]; failed: boolean }[] = [];
  for (const target of targets) {
    const ticks: number[] = [];
    let failed = false;
    for (const wordPos of target.words) {
      const raw = bitmaps[cursor++] ?? null;
      if (raw === null) {
        failed = true;
        continue;
      }
      ticks.push(...ticksInWord(BigInt(raw), wordPos, target.pool.tickSpacing));
    }
    tickRequests.push({ target, ticks, failed });
  }

  const tickCalls = tickRequests.flatMap(({ target, ticks }) => ticks.map((tick) => tickCall(target.pool, tick)));
  const liquidity = await multicall(rpc, tickCalls, blockTag);

  let loaded = 0;
  cursor = 0;
  for (const { target, ticks, failed } of tickRequests) {
    const entries: TickEntry[] = [];
    let bad = failed;
    for (const tick of ticks) {
      const raw = liquidity[cursor++] ?? null;
      if (raw === null || raw.length < 2 + 128) {
        bad = true;
        continue;
      }
      // Both views return liquidityGross first and liquidityNet second.
      entries.push({ tick, liquidityNet: BigInt.asIntN(256, BigInt(`0x${raw.slice(2 + 64, 2 + 128)}`)) });
    }
    if (bad) {
      skipped++;
      continue;
    }
    const spacing = target.pool.tickSpacing;
    const depth: Depth = {
      ticks: entries.sort((a, b) => a.tick - b.tick),
      lowTick: target.words[0]! * WORD_BITS * spacing,
      highTick: (target.words.at(-1)! + 1) * WORD_BITS * spacing,
    };
    book.setDepth(target.pool.address, depth);
    loaded++;
  }
  return { loaded, skipped };
}
