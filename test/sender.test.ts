import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Outcome, SentTrade, SettledTrade } from '../src/paper/engine.ts';
import { DryRunSender } from '../src/sender/dry-run.ts';
import { GasWatch, gasBandOf, resultCsv, resultLine, totalsBy, type ResultRow } from '../src/sender/results.ts';
import { SHOTS_NEEDED, verdictOf, WINS_FOR_MODEL } from '../src/sender/shots.ts';
import { backrunTip, chooseTip, emptyingAmount, MIN_TIP_WEI_PER_GAS, PLAIN_TRANSFER_GAS, planAttempt, planBatch, SEND_LEAD_MS, type BackrunInput, type BatchInput, type BatchTrade, type OpenBookInput, type PlanInput } from '../src/sender/plan.ts';
import { DEFAULT_LIMITS, newRiskState, RiskGuard, type RiskLimits } from '../src/sender/risk.ts';

const NOON = Date.UTC(2026, 10, 4, 12);
const guard = (limits: Partial<RiskLimits> = {}): RiskGuard => new RiskGuard({ ...DEFAULT_LIMITS, ...limits }, newRiskState(NOON));
const attempt = (failureCostUsd = 0.05, pools = ['0xa', '0xb']) => ({ pools, failureCostUsd });

test('a normal attempt may go', () => {
  assert.deepEqual(guard().check(attempt(), NOON), { ok: true });
});

test('an attempt that could burn too much is refused however good it looks', () => {
  assert.deepEqual(guard().check(attempt(DEFAULT_LIMITS.maxAttemptFailureUsd + 0.01), NOON), { ok: false, reason: 'attempt-too-costly' });
});

test('input it cannot read is refused rather than trusted', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) assert.deepEqual(guard().check(attempt(bad), NOON), { ok: false, reason: 'invalid-input' });
});

test('the daily loss limit stops sending, and the next day it lifts', () => {
  const g = guard({ maxDailyLossUsd: 1, maxHourlyFailureUsd: 100 });
  g.record({ kind: 'stopped-early', costUsd: 1 }, NOON);
  assert.deepEqual(g.check(attempt(), NOON), { ok: false, reason: 'daily-loss-limit' });
  const tomorrow = NOON + 24 * 3_600_000;
  assert.deepEqual(g.check(attempt(), tomorrow), { ok: true });
});

test('wins offset the daily loss, so a good day is not stopped by its small failures', () => {
  const g = guard({ maxDailyLossUsd: 1, maxHourlyFailureUsd: 100 });
  g.record({ kind: 'won', netUsd: 5 }, NOON);
  for (let i = 0; i < 10; i++) g.record({ kind: 'stopped-early', costUsd: 0.5 }, NOON);
  assert.equal(g.check(attempt(), NOON).ok, true);
});

test('the hourly limit counts spending however much was won, and lifts as time passes', () => {
  const g = guard({ maxHourlyFailureUsd: 1 });
  g.record({ kind: 'won', netUsd: 100 }, NOON);
  g.record({ kind: 'stopped-early', costUsd: 0.98 }, NOON);
  assert.deepEqual(g.check(attempt(0.05), NOON), { ok: false, reason: 'hourly-failure-limit' }, 'counts this attempt as failed in advance');
  assert.equal(g.check(attempt(0.01), NOON).ok, true);
  assert.equal(g.check(attempt(0.05), NOON + 3_600_001).ok, true);
});

test('stopping at the price check never trips the failure streak, however often it happens', () => {
  const g = guard({ maxHourlyFailureUsd: 1e9, maxDailyLossUsd: 1e9 });
  for (let i = 0; i < 1000; i++) g.record({ kind: 'stopped-early', costUsd: 0.01 }, NOON);
  assert.equal(g.state.haltReason, null);
  assert.equal(g.check(attempt(), NOON).ok, true);
});

test('five costly failures in a row halt everything for good', () => {
  const g = guard();
  for (let i = 0; i < 4; i++) g.record({ kind: 'costly-failure', costUsd: 0.1, pools: [`0x${i}`] }, NOON);
  assert.equal(g.state.haltReason, null);
  g.record({ kind: 'costly-failure', costUsd: 0.1, pools: ['0x9'] }, NOON);
  assert.ok(g.state.haltReason);
  assert.deepEqual(g.check(attempt(), NOON + 7 * 24 * 3_600_000), { ok: false, reason: 'halted' }, 'waiting does not lift it');
});

test('a win breaks the streak of costly failures, but cheap stops do not', () => {
  const g = guard();
  for (let i = 0; i < 4; i++) g.record({ kind: 'costly-failure', costUsd: 0.1, pools: ['0x1'] }, NOON);
  g.record({ kind: 'stopped-early', costUsd: 0.01 }, NOON);
  assert.equal(g.state.consecutiveCostlyFailures, 4);
  g.record({ kind: 'won', netUsd: 1 }, NOON);
  assert.equal(g.state.consecutiveCostlyFailures, 0);
});

test('a pool behind a costly failure is avoided for a day', () => {
  const g = guard();
  g.record({ kind: 'costly-failure', costUsd: 0.1, pools: ['0xbad'] }, NOON);
  assert.deepEqual(g.check(attempt(0.05, ['0xgood', '0xbad']), NOON), { ok: false, reason: 'pool-in-quarantine' });
  assert.equal(g.check(attempt(0.05, ['0xgood']), NOON).ok, true);
  assert.equal(g.check(attempt(0.05, ['0xbad']), NOON + 24 * 3_600_000 + 1).ok, true);
});

test('the total loss limit is final', () => {
  const g = guard({ maxTotalLossUsd: 1, maxDailyLossUsd: 100, maxHourlyFailureUsd: 100 });
  g.record({ kind: 'stopped-early', costUsd: 1 }, NOON);
  assert.ok(g.state.haltReason);
  assert.deepEqual(g.check(attempt(), NOON + 30 * 24 * 3_600_000), { ok: false, reason: 'halted' });
});

test('saved state survives a restart, so restarting cannot reset a limit', () => {
  const g = guard();
  for (let i = 0; i < 5; i++) g.record({ kind: 'costly-failure', costUsd: 0.1, pools: ['0x1'] }, NOON);
  const restored = new RiskGuard(DEFAULT_LIMITS, JSON.parse(JSON.stringify(g.state)));
  assert.deepEqual(restored.check(attempt(), NOON), { ok: false, reason: 'halted' });
});

const sent = (overrides: Partial<SentTrade> = {}): SentTrade => ({
  decidedAtBlock: 500,
  route: ['0xw', '0xu'],
  pools: ['0xa', '0xb'],
  amountIn: 1000n,
  pricesAtDecision: [1n, 2n],
  startGap: 10n ** 16n,
  profitUsd: 10,
  bidUsd: 0.5,
  gasUnits: 400_000n,
  usdPerUnit: 1e-6,
  ...overrides,
});
const settled = (outcome: Outcome, netUsd = 5, overrides: Partial<SettledTrade> = {}): SettledTrade =>
  ({ decidedAtBlock: 500, pools: ['0xa', '0xb'], results: { realistic: { outcome, netUsd } }, ...overrides }) as SettledTrade;
const context = { nextBaseFeeWei: 200_000_000n, nativeUsd: 2000, timestamp: 1000, minNetUsd: 0.25, failureGasUnits: 60_000n };

const dryRun = async (limits: Partial<RiskLimits> = {}): Promise<{ sender: DryRunSender; file: string; done: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'cryptome-sender-'));
  const file = join(dir, 'sender.jsonl');
  return { sender: new DryRunSender(guard(limits), file), file, done: () => rm(dir, { recursive: true, maxRetries: 5 }) };
};

test('a dry run records what it would send, and counts a win', async () => {
  const { sender, file, done } = await dryRun();
  await sender.propose(sent(), context, NOON);
  await sender.settle(settled('won', 5), NOON);
  assert.equal(sender.summary.planned, 1);
  assert.equal(sender.summary.won, 1);
  assert.equal(sender.summary.netUsd, 5);
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { event: string; targetBlock?: number });
  assert.equal(lines[0]!.event, 'would-send');
  assert.equal(lines[0]!.targetBlock, 501);
  await done();
});

test('a lost attempt costs what a failure costs, not what the emulator booked', async () => {
  const { sender, done } = await dryRun();
  await sender.propose(sent(), context, NOON);
  await sender.settle(settled('lost-to-rival', 0), NOON);
  assert.equal(sender.summary.failed, 1);
  assert.ok(sender.summary.netUsd < 0);
  assert.ok(sender.summary.failureCostUsd > 0);
  await done();
});

test('what the limits refused never went out, so its result does not count', async () => {
  const { sender, done } = await dryRun({ maxAttemptFailureUsd: 0.0001 });
  await sender.propose(sent(), context, NOON);
  await sender.settle(settled('won', 1000), NOON);
  assert.equal(sender.summary.planned, 0);
  assert.equal(sender.summary.refused['attempt-too-costly'], 1);
  assert.equal(sender.summary.netUsd, 0);
  await done();
});

test('a trade missing from the block costs nothing', async () => {
  const { sender, done } = await dryRun();
  await sender.propose(sent(), context, NOON);
  await sender.settle(settled('not-included', 0), NOON);
  assert.equal(sender.summary.notIncluded, 1);
  assert.equal(sender.summary.netUsd, 0);
  await done();
});

test('a trade too thin to cover its costs is never planned', async () => {
  const { sender, done } = await dryRun();
  await sender.propose(sent({ profitUsd: 0.3 }), context, NOON);
  assert.equal(sender.summary.noPlan, 1);
  assert.equal(sender.summary.planned, 0);
  await done();
});

const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  profitUsd: 10,
  bidUsd: 0.5,
  usdPerStartUnit: 1e-6,
  gasUnits: 400_000n,
  nextBaseFeeWei: 200_000_000n,
  nativeUsd: 2000,
  decidedBlockTimestamp: 1_000,
  decidedBlock: 500,
  failureGasUnits: 60_000n,
  minNetUsd: 0.25,
  ...overrides,
});

test('emptying the sender leaves exactly the fee of the transfer', () => {
  assert.equal(emptyingAmount(10n ** 18n, 1000n), 10n ** 18n - PLAIN_TRANSFER_GAS * 1000n);
});

test('emptying refuses when the balance cannot even pay for the transfer', () => {
  assert.equal(emptyingAmount(PLAIN_TRANSFER_GAS * 1000n, 1000n), 0n);
  assert.equal(emptyingAmount(5n, 1000n), 0n);
});

test('the tip pays exactly the bid over the gas the trade uses', () => {
  const plan = planAttempt(input())!;
  const paid = (Number(plan.tipWeiPerGas * 400_000n) / 1e18) * 2000;
  assert.ok(Math.abs(paid - 0.5) < 1e-6);
  assert.equal(plan.maxFeePerGas, 200_000_000n + plan.tipWeiPerGas);
  assert.equal(plan.targetBlock, 501);
});

test('a tiny bid still pays the minimum tip, and the trade must cover it', () => {
  const small = planAttempt(input({ bidUsd: 0.001 }))!;
  assert.equal(small.tipWeiPerGas, MIN_TIP_WEI_PER_GAS);
  const tipUsd = (Number(MIN_TIP_WEI_PER_GAS * 400_000n) / 1e18) * 2000;
  const gasUsd = (400_000 * 0.2e9 * 2000) / 1e18;
  const justShort = gasUsd + tipUsd + 0.25 - 0.001;
  assert.equal(planAttempt(input({ bidUsd: 0.001, profitUsd: justShort })), null, 'too thin once the real tip is counted');
});

const openBook = (trades: { profitUsd: number; gasUnits?: bigint; needTipWei?: bigint }[], overrides: Partial<OpenBookInput> = {}): ReturnType<typeof chooseTip> =>
  chooseTip({
    trades: trades.map((trade) => ({ profitUsd: trade.profitUsd, gasUnits: trade.gasUnits ?? 400_000n, needTipWei: trade.needTipWei ?? 0n })),
    baseTipWei: 100_000_000n,
    nextBaseFeeWei: 100_000_000n,
    nativeUsd: 2000,
    minNetUsd: 0.25,
    ...overrides,
  });

test('with nobody in the way the tip stays where it was and everything goes', () => {
  assert.deepEqual(openBook([{ profitUsd: 5 }, { profitUsd: 3 }]), { tipWei: 100_000_000n, keep: [0, 1] });
});

test('a rival worth beating raises the tip to just the level needed', () => {
  assert.deepEqual(openBook([{ profitUsd: 50, needTipWei: 3_000_000_000n }]), { tipWei: 3_000_000_000n, keep: [0] });
});

test('a rival not worth beating closes that route, and sending it would only burn gas', () => {
  assert.equal(openBook([{ profitUsd: 1, needTipWei: 3_000_000_000n }]), null, 'the tip alone would cost more than the trade');
  assert.deepEqual(openBook([{ profitUsd: 1, needTipWei: 3_000_000_000n }, { profitUsd: 2 }]), { tipWei: 100_000_000n, keep: [1] });
});

test('a higher tip must also pay for what it costs in all the blocks where the attempt just fails', () => {
  // Beating this rival leaves about $2.50, less than 18 failures at 3 gwei cost.
  assert.equal(openBook([{ profitUsd: 5, needTipWei: 3_000_000_000n }]), null);
});

test('a jump in the base fee stops trades that would not cover their failures', () => {
  const spike = { nextBaseFeeWei: 6_000_000_000n };
  assert.equal(openBook([{ profitUsd: 8, gasUnits: 300_000n }], spike), null, 'a failure costs about 60 cents, so 18 of them outweigh this');
  assert.notEqual(openBook([{ profitUsd: 40, gasUnits: 300_000n }], spike), null);
  assert.notEqual(openBook([{ profitUsd: 8, gasUnits: 300_000n }]), null, 'at the usual base fee the same trade goes');
});

test('one raised tip is paid on all the gas, so a large trade can leave a small route behind', () => {
  const choice = openBook([{ profitUsd: 60, needTipWei: 2_000_000_000n }, { profitUsd: 1 }])!;
  assert.equal(choice.tipWei, 2_000_000_000n);
  assert.deepEqual(choice.keep, [0], 'the small one cannot afford that tip');
});

test('a further route goes only if it pays for what it adds to every failed attempt', () => {
  const trades = [{ profitUsd: 20 }, { profitUsd: 3 }];
  assert.deepEqual(openBook(trades), { tipWei: 100_000_000n, keep: [0, 1] }, 'at the usual base fee it adds a cent or so');
  assert.deepEqual(openBook(trades, { nextBaseFeeWei: 2_000_000_000n }), { tipWei: 100_000_000n, keep: [0] }, 'at 2 gwei it adds about 13 cents, and 18 of those outweigh the $1.32 it earns');
  assert.deepEqual(openBook([{ profitUsd: 3 }, { profitUsd: 20 }], { nextBaseFeeWei: 2_000_000_000n }), { tipWei: 100_000_000n, keep: [1] }, 'whatever the order they come in');
});

const backrun = (overrides: Partial<BackrunInput> = {}): bigint | null =>
  backrunTip({ profitUsd: 20, gasUnits: 400_000n, openerTipWei: 2_000_000_000n, rivalTipWei: 0n, nextBaseFeeWei: 100_000_000n, nativeUsd: 2000, minNetUsd: 0.25, ...overrides });

test('a place behind a pending transaction pays less than it and more than any rival below it', () => {
  const tip = backrun({ rivalTipWei: 500_000_000n })!;
  assert.ok(tip < 2_000_000_000n);
  assert.ok(tip > 500_000_000n);
});

test('there is no place between two equal tips, nor below a transaction paying nothing', () => {
  assert.equal(backrun({ rivalTipWei: 2_000_000_000n }), null);
  assert.equal(backrun({ rivalTipWei: 1_999_999_999n }), null, 'no whole number fits between these');
  assert.equal(backrun({ openerTipWei: 0n }), null);
  assert.equal(backrun({ openerTipWei: 1n }), null);
});

test('it pays up to a tenth of the profit to keep later rivals behind, and never reaches the opener', () => {
  const tip = backrun({ profitUsd: 2000, openerTipWei: 1_000_000_000n, gasUnits: 400_000n })!;
  assert.equal(tip, 999_999_999n, 'a tenth of this profit would pay far more than the opener');
  const small = backrun({ profitUsd: 20, openerTipWei: 100_000_000_000n })!;
  const usd = (Number(small * 400_000n) / 1e18) * 2000;
  assert.ok(Math.abs(usd - 2) < 0.01, 'a tenth of $20 per all the gas');
});

test('a place is refused when the trade would not cover the attempts failing in other blocks', () => {
  assert.equal(backrun({ profitUsd: 0.2 }), null, 'below the minimum in this block alone');
  // Worth $0.40 after costs, while each failure at this tip costs about $0.20 and comes 11.5 times over.
  assert.equal(backrun({ profitUsd: 1.5, openerTipWei: 2_000_000_000n, rivalTipWei: 1_900_000_000n }), null);
  assert.notEqual(backrun({ profitUsd: 1.5, openerTipWei: 10_000_000n, rivalTipWei: 0n }), null, 'at a tiny tip a failure costs next to nothing');
});

test('a batch can pay an exact tip below the usual minimum', () => {
  const plan = planBatch(batchInput({ trades: [route(10)], exactTipWei: 1000n }))!;
  assert.equal(plan.tipWeiPerGas, 1000n);
  assert.equal(plan.maxFeePerGas, 200_001_000n);
});

test('a ceiling lowers a large bid, but never below what must be paid to replace or to beat a rival', () => {
  const trades = [route(1000)];
  assert.ok(planBatch(batchInput({ trades }))!.tipWeiPerGas > 60_000_000_000n, 'its usual bid');
  assert.equal(planBatch(batchInput({ trades, atMostTipWei: 1_000_000_000n }))!.tipWeiPerGas, 1_000_000_000n);
  assert.equal(planBatch(batchInput({ trades, atMostTipWei: 1_000_000_000n, atLeastTipWei: 3_000_000_000n }))!.tipWeiPerGas, 3_000_000_000n);
  assert.ok(planBatch(batchInput({ trades, atMostTipWei: 100_000_000_000n }))!.tipWeiPerGas < 100_000_000_000n, 'a ceiling above the bid changes nothing');
});

const resultRow = (overrides: Partial<ResultRow> = {}): ResultRow => ({ at: 0, hash: '0xabc', targetBlock: 100, minedBlock: 100, blockKind: 'validator', result: 'won', netUsd: 3.24, expectedUsd: 4.23, routes: 2, placed: false, raised: false, tipGwei: 0.1, baseFeeGwei: 0.08, gasUsed: 350_000, totalNetUsd: 5, ...overrides });

test('a line says at a glance whether an attempt made or lost money', () => {
  const win = resultLine(resultRow(), 3.24);
  assert.ok(win.includes('ПЛЮС +$3.24') && win.includes('валидатор') && win.includes('всего +$5.00'));
  const loss = resultLine(resultRow({ result: 'stopped-early', netUsd: -0.37, blockKind: 'builder' }), -0.37);
  assert.ok(loss.includes('МИНУС -$0.37') && loss.includes('билдер') && loss.includes('разрыв закрыли раньше нас'));
  assert.ok(resultLine(resultRow({ result: 'stopped-early', netUsd: -0.02, minedBlock: 102 }), 0).includes('опоздала на 2'));
  assert.ok(resultLine(resultRow({ placed: true }), 0).includes('за чужой транзакцией'));
});

test('a record has one field per column, so it opens as a table', () => {
  const fields = resultCsv(resultRow({ minedBlock: null, blockKind: null }));
  assert.equal(fields.split(',').length, 15);
});

test('attempts add up by whatever is asked, and gas falls into its band', () => {
  const groups = totalsBy([{ netUsd: 3, won: true, k: 'a' }, { netUsd: -1, won: false, k: 'a' }, { netUsd: -2, won: false, k: 'b' }], (row) => row.k);
  assert.deepEqual(groups.get('a'), { attempts: 2, wins: 1, wonUsd: 3, lostUsd: -1 });
  assert.equal(groups.get('b')!.lostUsd, -2);
  assert.equal(gasBandOf(0.08), 'до 0.2 гвей');
  assert.equal(gasBandOf(5.9), 'от 3 гвей');
});

test('gas reports a surge once, and that it ended once, without calling the surge usual', () => {
  const watch = new GasWatch();
  for (let i = 0; i < 30; i++) assert.equal(watch.note(0.1), null);
  assert.ok(watch.note(0.5)!.includes('Газ вырос'));
  assert.equal(watch.note(1), null, 'it said so already');
  for (let i = 0; i < 400; i++) assert.equal(watch.note(2), null, 'the high fee does not become the new usual');
  assert.ok(watch.note(0.12)!.includes('вернулся'));
  assert.equal(watch.surging, false);
});

test('the plan is judged only after ten shots at self-built blocks, by how many won', () => {
  assert.equal(verdictOf(9, 0), 'running');
  assert.equal(verdictOf(9, 9), 'running', 'an early streak decides nothing');
  assert.equal(verdictOf(SHOTS_NEEDED, 0), 'stop');
  assert.equal(verdictOf(SHOTS_NEEDED, 1), 'works-below-model');
  assert.equal(verdictOf(SHOTS_NEEDED, WINS_FOR_MODEL - 1), 'works-below-model');
  assert.equal(verdictOf(SHOTS_NEEDED, WINS_FOR_MODEL), 'model-holds');
  assert.equal(verdictOf(14, 0), 'stop');
});

const batchInput = (overrides: Partial<BatchInput> = {}): BatchInput => ({
  trades: [],
  nextBaseFeeWei: 200_000_000n,
  nativeUsd: 2000,
  decidedBlockTimestamp: 1000,
  decidedBlock: 500,
  failureGasUnits: 60_000n,
  minNetUsd: 0.25,
  ...overrides,
});
const route = (profitUsd: number, gasUnits = 400_000n): BatchTrade => ({ profitUsd, bidUsd: profitUsd * 0.05, usdPerStartUnit: 2000 / 1e18, gasUnits, startGap: 10n ** 16n });

test('a batch carries every trade that pays, best first, under one tip', () => {
  const plan = planBatch(batchInput({ trades: [route(2), route(10), route(5)] }))!;
  assert.deepEqual(plan.routes.map((r) => r.index), [1, 2, 0]);
  assert.equal(plan.gasLimit, plan.routes.reduce((total, r) => total + r.gasLimit, 0n));
  assert.equal(plan.routes[0]!.gasLimit, 680_000n, 'a margin, and a reserve for pools that insist on gas being left');
  assert.equal(plan.targetBlock, 501);
});

test('each route of a batch must end with at least its own share of the costs', () => {
  const plan = planBatch(batchInput({ trades: [route(10), route(5, 800_000n)] }))!;
  const price = 200_000_000n + plan.tipWeiPerGas;
  const costUsd = (gas: bigint): number => (Number(gas * price) / 1e18) * 2000 + 0.25;
  const unitsToUsd = (units: bigint): number => (Number(units) * 2000) / 1e18;
  assert.ok(Math.abs(unitsToUsd(plan.routes[0]!.minProfitUnits) - costUsd(400_000n)) < 1e-6);
  assert.ok(Math.abs(unitsToUsd(plan.routes[1]!.minProfitUnits) - costUsd(800_000n)) < 1e-6);
});

test('a route that cannot pay its share is left out, not carried by the others', () => {
  const plan = planBatch(batchInput({ trades: [route(20), route(0.3)] }))!;
  assert.deepEqual(plan.routes.map((r) => r.index), [0]);
  assert.equal(planBatch(batchInput({ trades: [route(0.3), route(0.2)] })), null);
});

test('leaving a route out does not stop the batch from settling on a tip', () => {
  // The large bid sets a high tip, which the small route cannot afford.
  const plan = planBatch(batchInput({ trades: [route(100), route(1)] }))!;
  assert.ok(plan.tipWeiPerGas >= MIN_TIP_WEI_PER_GAS);
  assert.deepEqual(plan.routes.map((r) => r.index), [0]);
});

test('a batch stops at its size limits', () => {
  const many = Array.from({ length: 12 }, (_, i) => route(50 - i));
  assert.equal(planBatch(batchInput({ trades: many }))!.routes.length, 8);
  assert.equal(planBatch(batchInput({ trades: many, maxRoutes: 1 }))!.routes.length, 1);
  const heavy = Array.from({ length: 4 }, () => route(500, 2_500_000n));
  assert.equal(planBatch(batchInput({ trades: heavy }))!.routes.length, 2, 'two fit under the gas limit, a third does not');
});

test('a failed batch costs more with more routes, and a replacement pays what nodes demand', () => {
  const one = planBatch(batchInput({ trades: [route(10)] }))!;
  const two = planBatch(batchInput({ trades: [route(10), route(10)] }))!;
  assert.ok(two.failureCostUsd > one.failureCostUsd);
  const replacing = planBatch(batchInput({ trades: [route(10)], atLeastTipWei: 3_000_000_000n, atLeastMaxFeeWei: 9_000_000_000n }))!;
  assert.equal(replacing.tipWeiPerGas, 3_000_000_000n);
  assert.equal(replacing.maxFeePerGas, 9_000_000_000n);
});

test('taking over a nonce pays at least what was asked, and the trade must still cover it', () => {
  const plan = planAttempt(input({ atLeastTipWei: 1_000_000_000n, atLeastMaxFeeWei: 3_000_000_000n }))!;
  assert.equal(plan.tipWeiPerGas, 1_000_000_000n);
  assert.equal(plan.maxFeePerGas, 3_000_000_000n);
  assert.equal(planAttempt(input({ profitUsd: 0.5, atLeastTipWei: 10_000_000_000n })), null);
});

test('the contract is told to refuse anything below what the trade will have paid', () => {
  const plan = planAttempt(input())!;
  const gasUsd = (400_000 * 0.2e9 * 2000) / 1e18;
  const expected = (gasUsd + 0.5 + 0.25) / 1e-6;
  assert.ok(Math.abs(Number(plan.minProfitUnits) - expected) <= 2);
});

test('a failed attempt is priced at the gas it burns with the tip on top', () => {
  const plan = planAttempt(input())!;
  const expected = (60_000 * Number(plan.maxFeePerGas) * 2000) / 1e18;
  assert.ok(Math.abs(plan.failureCostUsd - expected) < 1e-9);
  assert.ok(plan.failureCostUsd < 0.2);
});

test('it goes out shortly before the block, leaving copiers little time', () => {
  assert.equal(planAttempt(input())!.sendAtMs, (1_000 + 12) * 1000 - SEND_LEAD_MS);
});

test('a trade that would not cover its own costs gets no plan at all', () => {
  assert.equal(planAttempt(input({ profitUsd: 0.6 })), null);
});

test('nonsense gets no plan rather than a wrong one', () => {
  assert.equal(planAttempt(input({ gasUnits: 0n })), null);
  assert.equal(planAttempt(input({ nativeUsd: 0 })), null);
  assert.equal(planAttempt(input({ usdPerStartUnit: 0 })), null);
  assert.equal(planAttempt(input({ bidUsd: Number.NaN })), null);
});
