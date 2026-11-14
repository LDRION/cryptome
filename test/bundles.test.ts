import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, parseTransaction, recoverMessageAddress, stringToBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { rawOfPending, sendBundle, signatureHeader, traceAtEureka, type BundleEndpoint } from '../src/sender/bundles.ts';

const account = privateKeyToAccount(generatePrivateKey());
const SIGNED = ['0xabcd'] as const;
const ENDPOINTS: BundleEndpoint[] = [
  { name: 'signing', url: 'https://signing.example', needsSignature: true },
  { name: 'open', url: 'https://open.example', needsSignature: false },
];

const answering = (reply: (url: string) => Response): { fetcher: typeof fetch; calls: { url: string; init: RequestInit }[] } => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply(url);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
};
const ok = (): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { bundleHash: '0x1' } }));

test('the signature is over the hex hash of the exact body, as the builders specify', async () => {
  const body = '{"a":1}';
  const [address, signature] = (await signatureHeader(account, body)).split(':');
  assert.equal(address, account.address);
  const signer = await recoverMessageAddress({ message: keccak256(stringToBytes(body)), signature: signature as `0x${string}` });
  assert.equal(signer, account.address);
});

test('a bundle names one transaction and one block, and is signed only where that is asked for', async () => {
  const { fetcher, calls } = answering(ok);
  const answers = await sendBundle(ENDPOINTS, SIGNED, 255, account, fetcher);
  assert.deepEqual(answers.map((answer) => answer.ok), [true, true]);
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.method, 'eth_sendBundle');
  assert.deepEqual(body.params, [{ txs: SIGNED, blockNumber: '0xff' }], 'nothing is allowed to revert, so a failure is thrown away');
  const headers = (url: string): Record<string, string> => calls.find((call) => call.url === url)!.init.headers as Record<string, string>;
  assert.ok(headers('https://signing.example')['X-Flashbots-Signature']);
  assert.equal(headers('https://open.example')['X-Flashbots-Signature'], undefined);
});

const asReceived = (raw: `0x${string}`, extra: Record<string, unknown>): Record<string, unknown> => {
  const tx = parseTransaction(raw);
  const hex = (x: bigint | number | undefined): string => `0x${BigInt(x ?? 0).toString(16)}`;
  return { hash: keccak256(raw), chainId: hex(tx.chainId), nonce: hex(tx.nonce), gas: hex(tx.gas), to: tx.to, value: hex(tx.value), input: tx.data ?? '0x', r: tx.r, s: tx.s, accessList: tx.accessList ?? [], ...extra };
};

test('a pending transaction is rebuilt byte for byte from what the stream gives', async () => {
  const eip1559 = await account.signTransaction({ type: 'eip1559', chainId: 1, nonce: 5, gas: 21_000n, to: account.address, value: 7n, data: '0x1234', maxFeePerGas: 9n, maxPriorityFeePerGas: 3n });
  const parsed = parseTransaction(eip1559);
  const fields = asReceived(eip1559, { type: '0x2', maxFeePerGas: '0x9', maxPriorityFeePerGas: '0x3', yParity: `0x${parsed.yParity!.toString(16)}` });
  assert.equal(rawOfPending(fields), eip1559);

  const legacy = await account.signTransaction({ type: 'legacy', chainId: 1, nonce: 5, gas: 21_000n, to: account.address, value: 7n, data: '0x1234', gasPrice: 9n });
  const parsedLegacy = parseTransaction(legacy);
  assert.equal(rawOfPending(asReceived(legacy, { type: '0x0', gasPrice: '0x9', v: `0x${parsedLegacy.v!.toString(16)}` })), legacy);
});

test('a rebuild that does not match the hash, or an unknown type, gives nothing', async () => {
  const raw = await account.signTransaction({ type: 'eip1559', chainId: 1, nonce: 5, gas: 21_000n, to: account.address, value: 7n, maxFeePerGas: 9n, maxPriorityFeePerGas: 3n });
  const parsed = parseTransaction(raw);
  const good = asReceived(raw, { type: '0x2', maxFeePerGas: '0x9', maxPriorityFeePerGas: '0x3', yParity: `0x${parsed.yParity!.toString(16)}` });
  assert.equal(rawOfPending({ ...good, nonce: '0x6' }), null, 'one field off');
  assert.equal(rawOfPending({ ...good, type: '0x3' }), null, 'a blob transaction');
  assert.equal(rawOfPending({ hash: '0x1' }), null, 'fields missing');
});

test('one builder failing costs nothing with the others', async () => {
  const { fetcher } = answering((url) => {
    if (url.includes('signing')) throw new Error('connection refused');
    return ok();
  });
  const answers = await sendBundle(ENDPOINTS, SIGNED, 1, account, fetcher);
  assert.equal(answers[0]!.ok, false);
  assert.ok(answers[0]!.error?.includes('refused'));
  assert.equal(answers[1]!.ok, true);
});

test('the name a builder gives a bundle is kept, so it can be asked about later', async () => {
  const { fetcher } = answering(ok);
  const answers = await sendBundle(ENDPOINTS, SIGNED, 1, account, fetcher);
  assert.deepEqual(answers.map((answer) => answer.bundleHash), ['0x1', '0x1']);
});

test('Eureka is asked about a bundle by its name and says what became of it', async () => {
  const { fetcher, calls } = answering(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { bundleHash: '0xb1', status: 'InitialSimulationFail', error: 'execution reverted', builderPayment: '0', timeline: [] } })));
  assert.deepEqual(await traceAtEureka('0xb1', fetcher), { status: 'InitialSimulationFail', error: 'execution reverted', builderPayment: '0' });
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(calls[0]!.url, 'https://rpc.eurekabuilder.xyz');
  assert.equal(body.method, 'eureka_getBundleStats');
  assert.deepEqual(body.params, [{ bundleHash: '0xb1' }]);

  const missing = answering(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'bundle 0xb2 not found' } })));
  await assert.rejects(traceAtEureka('0xb2', missing.fetcher), /not found/);
});

test('a builder that says no in its answer counts as no', async () => {
  const { fetcher } = answering(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'unable to decode txs' } })));
  const answers = await sendBundle(ENDPOINTS, SIGNED, 1, account, fetcher);
  assert.equal(answers[0]!.ok, false);
  assert.equal(answers[0]!.error, 'unable to decode txs');
});
