import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import type { Rpc } from '../rpc.ts';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BATCH = 150;
const ABI = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) returns (Result[])']);

export type Call = { target: `0x${string}`; allowFailure: true; callData: `0x${string}` };

/** Runs many reads as one call against one state. A failed read comes back as null. */
export async function multicall(rpc: Rpc, calls: Call[], blockTag: string = 'latest'): Promise<(`0x${string}` | null)[]> {
  const results: (`0x${string}` | null)[] = [];
  for (let start = 0; start < calls.length; start += BATCH) {
    const data = encodeFunctionData({ abi: ABI, functionName: 'aggregate3', args: [calls.slice(start, start + BATCH)] });
    const raw = await rpc.call<`0x${string}`>('eth_call', [{ to: MULTICALL3, data }, blockTag]);
    const decoded = decodeFunctionResult({ abi: ABI, functionName: 'aggregate3', data: raw });
    for (const result of decoded) results.push(result.success && result.returnData !== '0x' ? result.returnData : null);
  }
  return results;
}
