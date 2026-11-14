import type { Rpc } from '../rpc.ts';
import type { PoolLog } from './pools.ts';

const blockOf = (log: PoolLog): number => Number(BigInt(log.blockNumber ?? '0x0'));

const inOrder = (logs: PoolLog[]): PoolLog[] =>
  logs.sort((a, b) => blockOf(a) - blockOf(b) || Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex)));

/** Fetches a block range by topic, halving it when a node refuses the size. */
export async function fetchRangeLogs(rpc: Rpc, topics: string[], from: number, to: number, addresses?: string[]): Promise<PoolLog[]> {
  try {
    const filter = { topics: [topics], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, ...(addresses ? { address: addresses } : {}) };
    return inOrder(await rpc.call<PoolLog[]>('eth_getLogs', [filter]));
  } catch (err) {
    if (to > from) {
      const middle = Math.floor((from + to) / 2);
      return inOrder([...(await fetchRangeLogs(rpc, topics, from, middle, addresses)), ...(await fetchRangeLogs(rpc, topics, middle + 1, to, addresses))]);
    }
    throw err;
  }
}

/**
 * Fetches one block by hash. A node that has not seen the block yet answers with an error,
 * where a query by number can return an empty list and silently lose the block's trades.
 */
export async function fetchBlockLogs(rpc: Rpc, topics: string[], blockHash: string): Promise<PoolLog[]> {
  return inOrder(await rpc.call<PoolLog[]>('eth_getLogs', [{ topics: [topics], blockHash }]));
}
