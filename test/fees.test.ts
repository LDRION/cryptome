import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi } from 'viem';
import { findDynamicFeePools, readFees } from '../src/paper/fees.ts';
import type { PoolMeta } from '../src/paper/pools.ts';
import type { Rpc } from '../src/rpc.ts';

const ABI = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) returns (Result[])']);
const UNISWAP_FACTORY = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
const OTHER_FACTORY = '0xf4fd2e6c5b60c5b365cd1b96dd6245e6d60414c2';

const pool = (n: number, kind: PoolMeta['kind'] = 'v3'): PoolMeta => ({ address: `0x${n.toString(16).padStart(40, '0')}`, kind, token0: '0xa', token1: '0xb', fee: 500, tickSpacing: 10 });
const word = (value: bigint): `0x${string}` => encodeAbiParameters([{ type: 'uint256' }], [value]);

/** A node that answers each pool's read from a table, and records which block was asked for. */
const fakeNode = (answers: Map<string, `0x${string}` | null>): Rpc & { tags: string[] } => {
  const tags: string[] = [];
  return {
    tags,
    async call<T>(_method: string, params: unknown[]): Promise<T> {
      tags.push(params[1] as string);
      const { args } = decodeFunctionData({ abi: ABI, data: (params[0] as { data: `0x${string}` }).data });
      const results = args[0].map((call) => {
        const answer = answers.get(call.target.toLowerCase()) ?? null;
        return { success: answer !== null, returnData: answer ?? '0x' };
      });
      return encodeFunctionResult({ abi: ABI, functionName: 'aggregate3', result: results }) as T;
    },
  };
};

const addressWord = (address: string): `0x${string}` => `0x${address.slice(2).padStart(64, '0')}`;

test('only pools outside the known fixed-fee factories count as moving', async () => {
  const [fixed, moving, silent] = [pool(1), pool(2), pool(3)];
  const node = fakeNode(new Map([[fixed.address, addressWord(UNISWAP_FACTORY)], [moving.address, addressWord(OTHER_FACTORY)]]));
  const dynamic = await findDynamicFeePools(node, [fixed, moving, silent, pool(4, 'v2'), pool(5, 'v4')], '0x10');
  assert.deepEqual(dynamic.map((p) => p.address), [moving.address, silent.address], 'a pool that will not answer is treated as moving');
  assert.deepEqual(node.tags, ['0x10']);
});

test('fees are read at the requested block, and a failed read stays empty rather than zero', async () => {
  const [a, b] = [pool(1), pool(2)];
  const node = fakeNode(new Map([[a.address, word(2637n)]]));
  assert.deepEqual(await readFees(node, [a, b], '0x20'), [2637, null]);
  assert.deepEqual(node.tags, ['0x20']);
});
