import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSlotOdds, SlotOdds } from '../src/sender/odds.ts';
import { backrunTip, chooseTip, FAILURES_PER_WIN } from '../src/sender/plan.ts';

const LOW = '0x00000000000000000000000000000000000000aa';
const HIGH = '0x00000000000000000000000000000000000000bb';
const entry = (slot: number, recipient: string) => ({ slot, entry: { message: { fee_recipient: recipient } } });
const fiveRelays = (lists: ReturnType<typeof entry>[]) => [lists, lists, lists, lists, lists];

const trained = (): SlotOdds => {
  const odds = new SlotOdds();
  for (let i = 0; i < 400; i++) odds.learn(LOW, i < 4 ? 'validator' : 'builder');
  for (let i = 0; i < 100; i++) odds.learn(HIGH, i < 60 ? 'validator' : 'builder');
  for (let i = 0; i < 40; i++) odds.learn('no-relay', i < 39 ? 'validator' : 'builder');
  odds.noteRelays(fiveRelays([entry(100, LOW), entry(101, HIGH), entry(103, LOW)]));
  return odds;
};

test('a slot is weighed by what its proposer has done before', () => {
  const odds = trained();
  const low = odds.failuresPerWinAt(100);
  const high = odds.failuresPerWinAt(101);
  const none = odds.failuresPerWinAt(102);
  assert.ok(low > 100, `rarely self-builds, so many failures come with each win: ${low}`);
  assert.ok(high < 5, `often self-builds: ${high}`);
  assert.ok(none < high, `registered with no relay, so it can only build for itself: ${none}`);
});

test('only a slot the relays cover and nobody registered counts as nearly sure', () => {
  const odds = trained();
  assert.equal(odds.isNearlySure(102), true);
  assert.equal(odds.isNearlySure(101), false, 'registered, however often it self-builds');
  assert.equal(odds.isNearlySure(99), false, 'not covered');
  const fewRelays = trained();
  fewRelays.noteRelays([[entry(100, LOW)]]);
  assert.equal(fewRelays.isNearlySure(102), false, 'too few relays answered to trust a missing registration');
});

test('with nothing to go on the usual figure stays', () => {
  const odds = trained();
  assert.equal(odds.failuresPerWinAt(99), FAILURES_PER_WIN, 'before the lists begin');
  assert.equal(odds.failuresPerWinAt(104), FAILURES_PER_WIN, 'after they end');

  const fewRelays = trained();
  fewRelays.noteRelays([[entry(100, LOW)], [entry(100, LOW)]]);
  assert.equal(fewRelays.failuresPerWinAt(100), FAILURES_PER_WIN, 'too few relays answered to trust a missing registration');

  const noHistory = new SlotOdds();
  noHistory.noteRelays(fiveRelays([entry(100, LOW)]));
  assert.equal(noHistory.failuresPerWinAt(100), FAILURES_PER_WIN);
});

test('a slot gives its self-build chance only when the relays and the history are enough to know it', () => {
  const odds = trained();
  assert.ok(odds.chanceAt(100)! < 0.05, 'rarely self-builds');
  assert.ok(odds.chanceAt(101)! > 0.5, 'registered, yet self-builds more often than not');
  assert.ok(odds.chanceAt(102)! > odds.chanceAt(101)!, 'on no relay it can only build for itself');
  assert.equal(odds.chanceAt(99), null, 'not covered');

  const noHistory = new SlotOdds();
  noHistory.noteRelays(fiveRelays([entry(100, LOW)]));
  assert.equal(noHistory.chanceAt(100), null);
});

test('a recipient with a short record stays near the average', () => {
  const odds = trained();
  const average = odds.chanceOf('never seen before');
  odds.learn('new', 'validator');
  const afterOne = odds.chanceOf('new');
  assert.ok(afterOne > average && afterOne < average + 0.1, 'one self-built block proves little');
});

test('each finished block joins the record, in a line that can be read back', async () => {
  const odds = trained();
  const before = odds.history.blocks;
  const line = odds.noteBlock(7, 101, 'validator')!;
  assert.equal(odds.history.blocks, before + 1);
  assert.deepEqual(JSON.parse(line), { block: 7, slot: 101, predicted: false, kind: 'validator', recipient: HIGH });
  assert.equal(JSON.parse(odds.noteBlock(8, 102, 'blank')!).predicted, true);
  assert.equal(odds.noteBlock(9, 999, 'builder'), null, 'a slot the lists do not cover teaches nothing');

  const dir = await mkdtemp(join(tmpdir(), 'odds-'));
  try {
    await writeFile(join(dir, 'proposers-a.jsonl'), `${line}\n${JSON.stringify({ block: 8, slot: 102, predicted: true, kind: 'blank', recipient: null })}\n`);
    await writeFile(join(dir, 'proposers-b.jsonl'), `${line}\n`);
    await writeFile(join(dir, 'paper-other.jsonl'), 'not a record\n');
    assert.deepEqual(loadSlotOdds(dir).history, { blocks: 2, own: 2 }, 'a block in two logs counts once');
  } finally {
    await rm(dir, { recursive: true });
  }
});

const book = (profitUsd: number, failuresPerWin?: number) =>
  chooseTip({ trades: [{ profitUsd, gasUnits: 400_000n, needTipWei: 0n }], baseTipWei: 100_000_000n, nextBaseFeeWei: 100_000_000n, nativeUsd: 2000, minNetUsd: 0.25, ...(failuresPerWin !== undefined ? { failuresPerWin } : {}) });

test('a small trade goes only into a slot likely to pay, and a large one goes anywhere', () => {
  // A failure here costs 4 cents.
  assert.notEqual(book(1, 2), null, 'worth it where a win comes about every other try');
  assert.equal(book(1, 100), null, 'not where 100 failures come with each win');
  assert.notEqual(book(50, 100), null, 'a large trade pays for them all');
  assert.notEqual(book(1), null, 'the usual figure when odds are unknown');
});

test('a place behind a pending transaction is weighed the same way', () => {
  const place = (failuresPerWin: number) => backrunTip({ profitUsd: 1, gasUnits: 400_000n, openerTipWei: 1_000_000_000n, rivalTipWei: 0n, nextBaseFeeWei: 100_000_000n, nativeUsd: 2000, minNetUsd: 0.25, failuresPerWin });
  assert.notEqual(place(2), null);
  assert.equal(place(1000), null);
});
