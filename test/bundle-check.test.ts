import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Rpc } from '../src/rpc.ts';
import { checkAtTopOfBlock } from '../src/sender/bundle-check.ts';

const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const EXECUTOR = '0x00000000000000000000000000000000c0ffee01';
const signed = (from: typeof account, nonce: number, data: `0x${string}`) =>
  from.signTransaction({ chainId: 1, type: 'eip1559', to: EXECUTOR, data, value: 0n, nonce, gas: 500_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n });

type Request = [{ blockStateCalls: { blockOverrides: { number: string }; calls: Record<string, string>[] }[]; validation: boolean }, string];

/** Answers the run without validation with `calls`, and the validated one with `validated`. */
const node = (calls: unknown[], validated: () => unknown = () => [{ calls }]): Rpc & { asked: Request[] } => {
  const asked: Request[] = [];
  return {
    asked,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      assert.equal(method, 'eth_simulateV1');
      asked.push(params as Request);
      return ((params as Request)[0].validation ? validated() : [{ calls }]) as T;
    },
  };
};

test('a bundle runs at the top of its own block, each transaction from its real sender', async () => {
  const opener = await signed(other, 3, '0xaa');
  const ours = await signed(account, 9, '0xbb');
  const rpc = node([{ status: '0x1', gasUsed: '0x5208' }, { status: '0x1', gasUsed: '0x30d40' }]);
  const check = await checkAtTopOfBlock(rpc, [opener, ours], 501);
  assert.deepEqual(check, { ok: true, gasUsed: 200_000, calls: [{ status: '0x1', gasUsed: 21_000 }, { status: '0x1', gasUsed: 200_000 }], valid: true });
  const [[plain, tag], [full]] = rpc.asked as [Request, Request];
  assert.equal(tag, '0x1f4', 'on the state the block starts from');
  assert.equal(plain.blockStateCalls[0]!.blockOverrides.number, '0x1f5', 'as the block it was meant for, which the contract checks');
  assert.equal(plain.validation, false);
  assert.deepEqual(plain.blockStateCalls[0]!.calls.map((call) => [call.from!.toLowerCase(), call.data, call.nonce]), [[other.address.toLowerCase(), '0xaa', undefined], [account.address.toLowerCase(), '0xbb', undefined]]);
  assert.equal(full.validation, true, 'the second run checks the signed transactions as a builder would');
  assert.deepEqual(full.blockStateCalls[0]!.calls.map((call) => [call.nonce, call.maxFeePerGas, call.maxPriorityFeePerGas]), [['0x3', '0x3b9aca00', '0x5f5e100'], ['0x9', '0x3b9aca00', '0x5f5e100']]);
});

test('a bundle that fails even at the top of its block says why', async () => {
  const rpc = node([{ status: '0x0', gasUsed: '0xc350', error: { message: 'execution reverted', data: '0x08c379a0' } }]);
  assert.deepEqual(await checkAtTopOfBlock(rpc, [await signed(account, 1, '0xbb')], 501), { ok: false, reason: '0x08c379a0', gasUsed: 50_000, calls: [{ status: '0x0', gasUsed: 50_000, revert: '0x08c379a0' }], valid: true });
});

test('a bundle whose opener fails is no good, even when our trade would go through', async () => {
  const rpc = node([{ status: '0x0', gasUsed: '0x7530', returnData: '0x' }, { status: '0x1', gasUsed: '0x30d40' }]);
  const check = await checkAtTopOfBlock(rpc, [await signed(other, 3, '0xaa'), await signed(account, 9, '0xbb')], 501);
  assert.equal(check.ok, false, 'a builder drops the whole bundle');
  assert.equal(check.reason, 'opener: 0x');
  assert.equal(check.gasUsed, 200_000, 'still what ours used');
});

test('signed transactions the node refuses are invalid, and a node out of reach is not', async () => {
  const refused = node([{ status: '0x1', gasUsed: '0x5208' }], () => {
    throw new Error('eth_simulateV1: err: nonce too high: tx: 86 state: 81');
  });
  const check = await checkAtTopOfBlock(refused, [await signed(account, 86, '0xbb')], 501);
  assert.equal(check.ok, true, 'the trade itself would go through');
  assert.equal(check.valid, false);
  assert.equal(check.invalid, 'err: nonce too high: tx: 86 state: 81');

  const away = node([{ status: '0x1', gasUsed: '0x5208' }], () => {
    throw new Error('eth_simulateV1: HTTP 503');
  });
  const unknown = await checkAtTopOfBlock(away, [await signed(account, 1, '0xbb')], 501);
  assert.equal(unknown.valid, undefined, 'nothing is known about the bundle');
  assert.equal(unknown.validityError, 'HTTP 503');
});
