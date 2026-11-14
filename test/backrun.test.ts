import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleBackrun, type BackrunAssumptions } from '../src/paper/backrun.ts';

const a: BackrunAssumptions = { bidShare: 0.85, sharedKeep: 0.1, outbidFactor: 1.01 };
const near = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('a hidden gap earns nothing in any world', () => {
  const r = settleBackrun([{ usd: 5000, visibility: 'unseen' }], 0, false, a);
  assert.deepEqual([r.soft, r.real, r.brutal], [0, 0, 0]);
});

test('a mere hint on the same pool is not treated as access', () => {
  const r = settleBackrun([{ usd: 5000, visibility: 'mev-share-possible' }], 0, false, a);
  assert.equal(r.sharedUsd, 0);
  assert.equal(r.soft, 0);
});

test('a visible trade earns only on its own share of a gap a whale opened', () => {
  const r = settleBackrun([{ usd: 760, visibility: 'unseen' }, { usd: 63, visibility: 'mempool' }], 0, false, a);
  assert.equal(r.publicUsd, 63);
  near(r.soft, 63 * 0.15);
});

test('an uncontested public gap keeps only the usual share, not the whole amount', () => {
  const r = settleBackrun([{ usd: 1000, visibility: 'mempool' }], 1, false, a);
  near(r.real, 150);
});

test('beating a rival leaves what is above its payment when that is the smaller amount', () => {
  const r = settleBackrun([{ usd: 1000, visibility: 'mempool' }], 900, false, a);
  near(r.real, 1000 - 900 * 1.01);
});

test('a rival paying more than the gap wins', () => {
  const r = settleBackrun([{ usd: 100, visibility: 'mempool' }], 100, false, a);
  assert.equal(r.real, 0, 'a tie plus the outbid margin is already above the gap');
  assert.ok(r.soft > 0);
});

test('an unknown rival payment counts as a loss', () => {
  const r = settleBackrun([{ usd: 1000, visibility: 'mempool' }], Number.POSITIVE_INFINITY, false, a);
  assert.equal(r.real, 0);
});

test('MEV-Share keeps only what its refund leaves', () => {
  const exact = settleBackrun([{ usd: 1000, visibility: 'mev-share-exact' }], 1, false, a);
  near(exact.real, 100);
  const topics = settleBackrun([{ usd: 1000, visibility: 'mev-share-topics' }], 1, false, a);
  near(topics.real, 100);
  const beaten = settleBackrun([{ usd: 1000, visibility: 'mev-share-topics' }], 2000, false, a);
  assert.equal(beaten.real, 0);
});

test('the brutal world loses any gap that closed inside the same block', () => {
  assert.equal(settleBackrun([{ usd: 1000, visibility: 'mempool' }], 0, true, a).brutal, 0);
  near(settleBackrun([{ usd: 1000, visibility: 'mempool' }], 0, false, a).brutal, 150);
});

test('public and shared parts add up', () => {
  const r = settleBackrun([{ usd: 100, visibility: 'mempool' }, { usd: 200, visibility: 'mev-share-topics' }], 0, false, a);
  near(r.soft, 15 + 20);
  near(r.real, 15 + 20);
});
