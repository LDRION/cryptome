import type { Rpc } from '../rpc.ts';
import { nativeFlows, type CallFrame } from '../trace.ts';
import type { Prices, RivalLookup, TipLookup } from './engine.ts';
import type { Memo } from './memo.ts';

interface Receipt {
  gasUsed: string;
  effectiveGasPrice: string;
}

const NO_ENTITY: ReadonlySet<string> = new Set();

/**
 * Finds what the transactions that closed a trade paid the block producer, in USD. Any
 * transaction counts, whatever its intent: inventory traders move the same prices as
 * arbitrage bots, and a builder picks whichever conflicting transaction pays more. A
 * failed lookup returns Infinity, so that missing data can only count against us.
 */
/** Finds the highest tip per gas among transactions, for blocks ordered by tip. */
export function createTipLookup(rpc: Rpc, memo?: Memo): TipLookup {
  const tipOf = async (block: number, hash: string): Promise<string> => {
    const [header, receipt] = await Promise.all([
      rpc.call<{ baseFeePerGas: string }>('eth_getBlockByNumber', [`0x${block.toString(16)}`, false]),
      rpc.call<Receipt>('eth_getTransactionReceipt', [hash]),
    ]);
    return (BigInt(receipt.effectiveGasPrice) - BigInt(header.baseFeePerGas)).toString();
  };
  return async (block: number, txHashes: string[]): Promise<number> => {
    let highest = 0;
    try {
      for (const hash of txHashes) {
        const tip = Number(memo ? await memo.get(`tip:${hash}`, () => tipOf(block, hash)) : await tipOf(block, hash));
        if (tip > highest) highest = tip;
      }
    } catch {
      return Number.POSITIVE_INFINITY;
    }
    return highest;
  };
}

export function createRivalLookup(rpc: Rpc, traceRpc: Rpc, memo?: Memo): RivalLookup {
  const paidWei = async (block: number, hash: string): Promise<string> => {
    const [header, receipt, trace] = await Promise.all([
      rpc.call<{ miner: string; baseFeePerGas: string }>('eth_getBlockByNumber', [`0x${block.toString(16)}`, false]),
      rpc.call<Receipt>('eth_getTransactionReceipt', [hash]),
      traceRpc.call<CallFrame>('debug_traceTransaction', [hash, { tracer: 'callTracer' }]),
    ]);
    const { toMiner } = nativeFlows(trace, header.miner, NO_ENTITY, '');
    const priorityFee = (BigInt(receipt.effectiveGasPrice) - BigInt(header.baseFeePerGas)) * BigInt(receipt.gasUsed);
    return (toMiner + priorityFee).toString();
  };

  return async (block: number, txHashes: string[], prices: Prices): Promise<number> => {
    let highest = 0;
    try {
      for (const hash of txHashes) {
        const wei = memo ? await memo.get(`paid:${hash}`, () => paidWei(block, hash)) : await paidWei(block, hash);
        const paid = (Number(wei) / 1e18) * prices.nativeUsd;
        if (paid > highest) highest = paid;
      }
    } catch {
      return Number.POSITIVE_INFINITY;
    }
    return highest;
  };
}
