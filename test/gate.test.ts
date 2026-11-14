import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, type GatePolicy, type Opportunity } from '../src/gate.ts';

const policy: GatePolicy = {
  profitHaircut: 0.2,
  minNetUsd: 0.5,
  minExpectedValueUsd: 0.05,
  maxStateAgeMs: 50,
  remainingLossBudgetUsd: 10,
};

const good: Opportunity = {
  simulatedProfitUsd: 10,
  gasUsd: 0.5,
  builderPaymentUsd: 1,
  failureGasUsd: 0.3,
  winProbability: 0.5,
  stateAgeMs: 5,
  routeVetted: true,
  mode: 'pays-gas',
};

const reasonOf = (o: Partial<Opportunity>, p: Partial<GatePolicy> = {}): string | undefined => {
  const decision = decide({ ...good, ...o }, { ...policy, ...p });
  return decision.send ? undefined : decision.reason;
};

test('sends a clearly profitable operation and reports its numbers', () => {
  const decision = decide(good, policy);
  assert.equal(decision.send, true);
  if (!decision.send) return;
  assert.ok(Math.abs(decision.worstCaseNetUsd - 6.5) < 1e-9);
  assert.ok(Math.abs(decision.expectedValueUsd - (0.5 * 6.5 - 0.5 * 0.3)) < 1e-9);
});

test('refuses when gas and the builder payment exceed the haircut profit', () => {
  assert.equal(reasonOf({ simulatedProfitUsd: 1, gasUsd: 0.5, builderPaymentUsd: 0.4 }), 'loses-even-when-it-wins');
});

test('the haircut alone can turn a thin win into a refusal', () => {
  const thin = { simulatedProfitUsd: 2, gasUsd: 1, builderPaymentUsd: 0 };
  assert.equal(reasonOf(thin, { profitHaircut: 0 }), undefined);
  assert.equal(reasonOf(thin, { profitHaircut: 0.5 }), 'loses-even-when-it-wins');
});

test('refuses a real win when failed attempts make it unprofitable on average', () => {
  const crowded = { simulatedProfitUsd: 2, gasUsd: 0.1, builderPaymentUsd: 0, winProbability: 0.05, failureGasUsd: 0.5 };
  assert.equal(reasonOf(crowded), 'negative-expected-value');
});

test('the same crowded trade passes when failure costs nothing', () => {
  const crowded = { simulatedProfitUsd: 2, gasUsd: 0.1, builderPaymentUsd: 0, winProbability: 0.05, failureGasUsd: 0.5 };
  assert.equal(reasonOf({ ...crowded, mode: 'revert-protected' }), undefined);
});

test('stops gas-paying attempts once the loss budget runs out', () => {
  assert.equal(reasonOf({}, { remainingLossBudgetUsd: 0.1 }), 'loss-budget-exhausted');
});

test('an empty loss budget does not block attempts that cannot lose', () => {
  assert.equal(reasonOf({ mode: 'revert-protected' }, { remainingLossBudgetUsd: 0 }), undefined);
});

test('refuses stale state and unvetted routes even when profit looks huge', () => {
  assert.equal(reasonOf({ simulatedProfitUsd: 1e6, stateAgeMs: 51 }), 'stale-state');
  assert.equal(reasonOf({ simulatedProfitUsd: 1e6, routeVetted: false }), 'unvetted-route');
});

test('fails closed on every kind of broken number', () => {
  const broken: Partial<Opportunity>[] = [
    { simulatedProfitUsd: Number.NaN },
    { simulatedProfitUsd: Number.POSITIVE_INFINITY },
    { simulatedProfitUsd: -1 },
    { gasUsd: Number.NaN },
    { gasUsd: -0.01 },
    { builderPaymentUsd: Number.NaN },
    { failureGasUsd: Number.NaN },
    { stateAgeMs: Number.NaN },
    { winProbability: Number.NaN },
    { winProbability: 1.01 },
    { winProbability: -0.01 },
  ];
  for (const input of broken) assert.equal(reasonOf(input), 'invalid-input', JSON.stringify(input));
  assert.equal(reasonOf({}, { profitHaircut: Number.NaN }), 'invalid-input');
  assert.equal(reasonOf({}, { profitHaircut: 1.5 }), 'invalid-input');
  assert.equal(reasonOf({}, { remainingLossBudgetUsd: Number.NaN }), 'invalid-input');
});

test('a broken policy threshold refuses instead of passing', () => {
  assert.equal(reasonOf({}, { minNetUsd: Number.NaN }), 'loses-even-when-it-wins');
  assert.equal(reasonOf({}, { minExpectedValueUsd: Number.NaN }), 'negative-expected-value');
  assert.equal(reasonOf({}, { maxStateAgeMs: Number.NaN }), 'stale-state');
});
