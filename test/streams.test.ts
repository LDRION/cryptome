import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addGap, newVisibilityStats, parseStreamMessage, PendingTracker } from '../src/paper/streams.ts';

const subscription = (params: unknown): string => JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params });

test('stream messages are read by what they carry', () => {
  assert.deepEqual(parseStreamMessage(subscription({ result: '0xtx' })), { kind: 'transaction', hash: '0xtx' });
  assert.deepEqual(parseStreamMessage(subscription({ result: { hash: '0xtx' } })), { kind: 'transaction', hash: '0xtx' });
  const whole = { hash: '0xtx', input: '0x12', to: '0xa' };
  assert.deepEqual(parseStreamMessage(subscription({ result: whole })), { kind: 'transaction', hash: '0xtx', tx: whole }, 'a whole transaction arrives with its fields');
  const header = { parentHash: '0xp', hash: '0xh', number: '0x1' };
  assert.deepEqual(parseStreamMessage(subscription({ result: header })), { kind: 'head', header });
});

// This shape ended a 24-hour run: a subscription message with no result at all.
test('a message the stream should not have sent cannot end the run', () => {
  for (const text of [
    subscription({ subscription: '0x1' }),
    subscription({ result: null }),
    subscription({ result: 5 }),
    subscription({ result: {} }),
    JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription' }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xsubscriptionid' }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'rate limit' } }),
    'null',
    'not json',
    '',
  ]) {
    assert.equal(parseStreamMessage(text), null, text);
  }
});

const POOL = '0xabc';
const OTHER = '0xdef';
const BLOCK = 1_000_000;
const swap = { address: POOL, data: '0x1234' };

test('a transaction seen in the mempool before its block counts as visible', () => {
  const t = new PendingTracker();
  t.noteTransaction('0xtx', BLOCK - 5000);
  assert.equal(t.classify('0xtx', [swap], BLOCK), 'mempool');
});

test('seeing it only after the block started is too late', () => {
  const t = new PendingTracker();
  t.noteTransaction('0xtx', BLOCK + 1);
  assert.equal(t.classify('0xtx', [swap], BLOCK), 'unseen');
});

test('the first sighting is the one that counts', () => {
  const t = new PendingTracker();
  t.noteTransaction('0xtx', BLOCK - 5000);
  t.noteTransaction('0xtx', BLOCK + 5000);
  assert.equal(t.classify('0xtx', [swap], BLOCK), 'mempool');
});

test('a MEV-Share hint with identical log data is an exact match', () => {
  const t = new PendingTracker();
  t.noteHintEvent([{ address: POOL.toUpperCase().replace('0X', '0x'), data: '0x1234' }], BLOCK - 2000);
  assert.equal(t.classify('0xtx', [swap], BLOCK), 'mev-share-exact');
});

const ROUTER = `0x${'a'.repeat(64)}`;
const USER = `0x${'b'.repeat(64)}`;
const OTHER_USER = `0x${'c'.repeat(64)}`;
const HIDDEN_TOPIC = `0x${'0'.repeat(64)}`;
const landed = { address: POOL, data: '0x1234', topics: ['0xsig', ROUTER, USER] };

test('a hint revealing the same sender and recipient outranks a mere pool match', () => {
  const t = new PendingTracker();
  t.noteHintEvent([{ address: POOL, data: '0x9999', topics: ['0xsig', ROUTER, USER] }], BLOCK - 2000);
  assert.equal(t.classify('0xtx', [landed], BLOCK), 'mev-share-topics');
});

test('one revealed topic that disagrees rules the hint out', () => {
  const t = new PendingTracker();
  t.noteHintEvent([{ address: POOL, data: '0x9999', topics: ['0xsig', ROUTER, OTHER_USER] }], BLOCK - 2000);
  assert.equal(t.classify('0xtx', [landed], BLOCK), 'mev-share-possible');
});

test('hidden topics are skipped, and all-hidden topics prove nothing', () => {
  const partly = new PendingTracker();
  partly.noteHintEvent([{ address: POOL, data: '0x9999', topics: ['0xsig', ROUTER, HIDDEN_TOPIC] }], BLOCK - 2000);
  assert.equal(partly.classify('0xtx', [landed], BLOCK), 'mev-share-topics');

  const hidden = new PendingTracker();
  hidden.noteHintEvent([{ address: POOL, data: '0x', topics: ['0xsig', HIDDEN_TOPIC, HIDDEN_TOPIC] }], BLOCK - 2000);
  assert.equal(hidden.classify('0xtx', [landed], BLOCK), 'mev-share-possible');
});

test('on V4 the pool id in the first topic does not count as evidence', () => {
  const manager = '0x000000000004444c5dc75cb358380d2e3de08a90';
  const id = `0x${'d'.repeat(64)}`;
  const swap4 = { address: manager, data: '0x1234', topics: ['0xsig', id, USER] };

  const sameSender = new PendingTracker();
  sameSender.noteHintEvent([{ address: manager, data: '0x', topics: ['0xsig', id, USER] }], BLOCK - 2000);
  assert.equal(sameSender.classify('0xtx', [swap4], BLOCK), 'mev-share-topics');

  const onlyId = new PendingTracker();
  onlyId.noteHintEvent([{ address: manager, data: '0x', topics: ['0xsig', id, HIDDEN_TOPIC] }], BLOCK - 2000);
  assert.equal(onlyId.classify('0xtx', [swap4], BLOCK), 'mev-share-possible');

  const otherPool = new PendingTracker();
  otherPool.noteHintEvent([{ address: manager, data: '0x', topics: ['0xsig', `0x${'e'.repeat(64)}`, USER] }], BLOCK - 2000);
  assert.equal(otherPool.classify('0xtx', [swap4], BLOCK), 'unseen');
});

test('a hint with hidden data on the same pool is only possible', () => {
  const t = new PendingTracker();
  t.noteHintEvent([{ address: POOL, data: '0x' }], BLOCK - 2000);
  assert.equal(t.classify('0xtx', [swap], BLOCK), 'mev-share-possible');
});

test('hidden data never matches exactly, even when the swap log is also empty', () => {
  const t = new PendingTracker();
  t.noteHintEvent([{ address: POOL, data: '0x000000' }], BLOCK - 2000);
  assert.equal(t.classify('0xtx', [{ address: POOL, data: '0x000000' }], BLOCK), 'mev-share-possible');
});

test('an old hint on the pool does not count as possible', () => {
  const t = new PendingTracker();
  t.noteHintEvent([{ address: POOL, data: '0x' }], BLOCK - 60_000);
  assert.equal(t.classify('0xtx', [swap], BLOCK), 'unseen');
});

test('a hint on another pool or after the block does not count', () => {
  const t = new PendingTracker();
  t.noteHintEvent([{ address: OTHER, data: '0x' }], BLOCK - 2000);
  t.noteHintEvent([{ address: POOL, data: '0x1234' }], BLOCK + 2000);
  assert.equal(t.classify('0xtx', [swap], BLOCK), 'unseen');
});

test('stronger evidence wins over weaker', () => {
  const t = new PendingTracker();
  t.noteHintEvent([{ address: POOL, data: '0x' }], BLOCK - 2000);
  t.noteTransaction('0xtx', BLOCK - 1000);
  assert.equal(t.classify('0xtx', [swap], BLOCK), 'mempool');
});

const running = (now: number): PendingTracker => {
  const t = new PendingTracker();
  t.noteTransaction('0x1', now - 100_000);
  t.noteHintEvent([], now - 100_000);
  t.noteTransaction('0x2', now - 1000);
  t.noteHintEvent([], now - 1000);
  return t;
};

test('a block is uncovered until both streams have been up long enough', () => {
  const now = 10_000_000;
  const t = new PendingTracker();
  assert.equal(t.isCovered(now, now), false);
  t.noteTransaction('0x1', now - 10_000);
  t.noteHintEvent([], now - 10_000);
  assert.equal(t.isCovered(now, now), false, 'not settled yet');
});

test('a block is covered while both streams keep flowing', () => {
  const now = 10_000_000;
  const t = new PendingTracker();
  for (let at = now - 100_000; at <= now; at += 10_000) {
    t.noteTransaction(`0x${at}`, at);
    t.noteHintEvent([], at);
  }
  assert.equal(t.isCovered(now, now), true);
});

test('one silent stream uncovers the block', () => {
  const now = 10_000_000;
  const t = new PendingTracker();
  for (let at = now - 100_000; at <= now - 40_000; at += 10_000) {
    t.noteTransaction(`0x${at}`, at);
    t.noteHintEvent([], at);
  }
  t.noteTransaction('0xlate', now);
  assert.equal(t.isCovered(now, now), false);
});

test('coming back from an outage needs to settle again before counting', () => {
  const now = 10_000_000;
  const t = new PendingTracker();
  for (let at = now - 500_000; at <= now - 200_000; at += 10_000) {
    t.noteTransaction(`0x${at}`, at);
    t.noteHintEvent([], at);
  }
  t.noteTransaction('0xback', now - 5000);
  t.noteHintEvent([], now - 5000);
  assert.equal(t.isCovered(now, now), false);
  assert.equal(running(now).isCovered(now, now), false, 'a long gap between events restarts the clock');
});

test('pruning forgets old sightings and keeps recent ones', () => {
  const now = 10_000_000;
  const t = new PendingTracker();
  t.noteTransaction('0xold', now - 4_000_000);
  t.noteTransaction('0xnew', now - 1000);
  t.noteHintEvent([{ address: POOL, data: '0x1234' }], now - 4_000_000);
  t.prune(now);
  assert.equal(t.classify('0xold', [], now), 'unseen');
  assert.equal(t.classify('0xnew', [], now), 'mempool');
  assert.equal(t.classify('0xtx', [swap], now), 'unseen');
});

test('gaps land in every bucket they qualify for', () => {
  const stats = newVisibilityStats([0, 10, 100]);
  addGap(stats, 5, [{ usd: 5, visibility: 'mempool' }]);
  addGap(stats, 50, [{ usd: 50, visibility: 'unseen' }]);
  addGap(stats, 500, [{ usd: 500, visibility: 'mev-share-exact' }]);
  const [all, ten, hundred] = stats.buckets;
  assert.equal(all!.count, 3);
  assert.equal(all!.usd, 555);
  assert.equal(all!.byClass.mempool.usd, 5);
  assert.equal(ten!.count, 2);
  assert.equal(ten!.byClass.mempool.count, 0);
  assert.equal(hundred!.count, 1);
  assert.equal(hundred!.byClass['mev-share-exact'].usd, 500);
});

// Shape of block 26333141: a $708k hidden trade opens the gap, then a visible $100k adds to it.
test('a visible trade gets credit only for what it added to a large gap', () => {
  const stats = newVisibilityStats([0, 100]);
  addGap(stats, 823, [{ usd: 760, visibility: 'unseen' }, { usd: 63, visibility: 'mempool' }]);
  const big = stats.buckets[1]!;
  assert.equal(big.count, 1);
  assert.equal(big.usd, 823);
  assert.equal(big.byClass.mempool.usd, 63);
  assert.equal(big.byClass.unseen.usd, 760);
});
