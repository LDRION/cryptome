import type { Rpc } from '../rpc.ts';
import { multicall, type Call } from './multicall.ts';
import type { PoolMeta } from './pools.ts';

const READ_FACTORY = '0xc45a0155';
const READ_FEE = '0xddca3f43';

/**
 * Factories whose pools keep the fee they were created with. Every other V3-style pool is
 * read each block, because some forks change the fee with volatility and raise it exactly
 * when a large trade opens a gap, which makes the gap look wider than it is.
 */
const STATIC_FEE_FACTORIES: ReadonlySet<string> = new Set([
  '0x1f98431c8ad98523631ae4a59f267346ea31f984',
  '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  '0xbaceb8ec6b9355dfc0269c18bac9d6e2bdc29c4f',
]);

const read = (pool: PoolMeta, selector: `0x${string}`): Call => ({ target: pool.address as `0x${string}`, allowFailure: true, callData: selector });

/** A pool that will not name its factory is treated as moving, which only costs one read. */
export async function findDynamicFeePools(rpc: Rpc, pools: PoolMeta[], blockTag: string = 'latest'): Promise<PoolMeta[]> {
  const v3 = pools.filter((pool) => pool.kind === 'v3');
  const factories = await multicall(rpc, v3.map((pool) => read(pool, READ_FACTORY)), blockTag);
  return v3.filter((_, i) => {
    const raw = factories[i];
    return raw === null || raw === undefined || !STATIC_FEE_FACTORIES.has(`0x${raw.slice(-40)}`.toLowerCase());
  });
}

/** The fee each pool charges at this block, in pool order. Null when one could not be read. */
export async function readFees(rpc: Rpc, pools: PoolMeta[], blockTag: string): Promise<(number | null)[]> {
  const raw = await multicall(rpc, pools.map((pool) => read(pool, READ_FEE)), blockTag);
  return raw.map((value) => (value === null ? null : Number(BigInt(value))));
}
