import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Log } from '../src/detect.ts';
import { bestPrefix, incomeOf, movementsOf, NATIVE, TRANSFER } from '../src/payouts/flows.ts';

const pad = (address: string): string => `0x${address.slice(2).padStart(64, '0')}`;
const transfer = (token: string, from: string, to: string, amount: bigint): Log => ({
  address: token,
  topics: [TRANSFER, pad(from), pad(to)],
  data: `0x${amount.toString(16).padStart(64, '0')}`,
});
const income = (logs: Log[], from: string, to: string, value = 0n) => incomeOf(movementsOf(logs), from, to, value);

const KEEPER = '0x1111111111111111111111111111111111111111';
const PROTOCOL = '0x2222222222222222222222222222222222222222';
const BOT = '0x3333333333333333333333333333333333333333';
const POOL = '0x4444444444444444444444444444444444444444';
const CRV = '0x5555555555555555555555555555555555555555';
const WETH = '0x6666666666666666666666666666666666666666';
const POOL2 = '0x7777777777777777777777777777777777777777';
const ZERO = '0x0000000000000000000000000000000000000000';

test('a reward paid straight to the caller is direct income', () => {
  const found = income([transfer(CRV, PROTOCOL, KEEPER, 5n)], KEEPER, PROTOCOL);
  assert.equal(found?.kind, 'direct');
  assert.equal(found?.payer, PROTOCOL);
  assert.equal(found?.net.get(CRV), 5n);
});

test('a reward swapped on the way out still counts, as Convex earmark bots do', () => {
  // Seen on chain: the Booster pays the bot contract CRV, which it sells for WETH in the same call.
  const logs = [transfer(CRV, PROTOCOL, BOT, 9n), transfer(CRV, BOT, POOL, 9n), transfer(WETH, POOL, BOT, 1n)];
  const found = income(logs, KEEPER, BOT);
  assert.equal(found?.kind, 'contract');
  assert.equal(found?.payer, PROTOCOL);
  assert.deepEqual([...found!.net], [[WETH, 1n]]);
});

test('an account that runs its own code, sender and target alike, is direct', () => {
  const logs = [transfer(CRV, PROTOCOL, KEEPER, 4n), transfer(CRV, KEEPER, POOL, 4n), transfer(WETH, POOL, KEEPER, 1n)];
  assert.equal(income(logs, KEEPER, KEEPER)?.kind, 'direct');
});

test('a swap is not income: the caller spends money it had', () => {
  assert.equal(income([transfer(WETH, KEEPER, POOL, 10n), transfer(CRV, POOL, KEEPER, 30n)], KEEPER, POOL), null);
});

test('an arbitrage is not income: every counterparty is paid as well as paying', () => {
  const logs = [transfer(WETH, POOL, BOT, 10n), transfer(CRV, BOT, POOL, 5n), transfer(CRV, POOL2, BOT, 5n), transfer(WETH, BOT, POOL2, 9n)];
  assert.equal(income(logs, KEEPER, BOT), null);
});

test('buying with native value is not income', () => {
  assert.equal(income([transfer(CRV, POOL, KEEPER, 30n)], KEEPER, POOL, 1n), null);
});

test('a mint is credited to the token', () => {
  const found = income([transfer(CRV, ZERO, BOT, 7n)], KEEPER, BOT);
  assert.equal(found?.kind, 'contract');
  assert.equal(found?.payer, CRV);
});

test('a deposit into a contract is not the contract earning', () => {
  assert.equal(income([transfer(CRV, KEEPER, PROTOCOL, 7n)], KEEPER, PROTOCOL), null);
});

test('NFT transfers and empty amounts are ignored', () => {
  const nft: Log = { address: CRV, topics: [TRANSFER, pad(PROTOCOL), pad(KEEPER), pad('0x01')], data: '0x' };
  assert.deepEqual(movementsOf([nft, transfer(CRV, PROTOCOL, KEEPER, 0n)]), []);
});

test('a replay keeps the best run of calls, before a later step gives the reward away', () => {
  const value = (net: Map<string, bigint>): number => Number(net.get(CRV) ?? 0n) + Number(net.get(NATIVE) ?? 0n);
  const calls = [[transfer(CRV, PROTOCOL, KEEPER, 9n)], null, [transfer(CRV, KEEPER, POOL, 9n), transfer(WETH, POOL, BOT, 1n)]];
  assert.deepEqual(bestPrefix(calls, KEEPER, value), { calls: 1, usd: 9, net: new Map([[CRV, 9n]]) });
  assert.equal(bestPrefix([[transfer(NATIVE, PROTOCOL, KEEPER, 3n)]], KEEPER, value).usd, 3);
});
