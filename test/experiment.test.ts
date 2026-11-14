import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { experimentLimits, loadOrStartExperiment } from '../src/sender/experiment.ts';
import { DEFAULT_LIMITS, newRiskState, RiskGuard } from '../src/sender/risk.ts';

test('the experiment halts once $3 is lost from where the total stood at its start', () => {
  const limits = experimentLimits(DEFAULT_LIMITS, { startedAt: '2026-11-10T00:00:00Z', startNetUsd: 0.63, lossBudgetUsd: 3 });
  assert.equal(limits.maxAttemptFailureUsd, 0.15, 'one failure cannot spend the budget');
  const state = { ...newRiskState(0), totalNetUsd: 0.63 };
  const guard = new RiskGuard(limits, state);
  guard.record({ kind: 'stopped-early', costUsd: 2.9 }, 1);
  assert.equal(guard.state.haltReason, null, '$2.90 lost, still within $3');
  guard.record({ kind: 'stopped-early', costUsd: 0.11 }, 2);
  assert.match(guard.state.haltReason ?? '', /total loss/, '$3.01 lost: stopped');
  assert.deepEqual(guard.check({ pools: [], failureCostUsd: 0.01 }, 3), { ok: false, reason: 'halted' });
});

test('a restart keeps the experiment start rather than beginning a new budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cryptome-exp-'));
  const file = join(dir, 'experiment.json');
  const first = loadOrStartExperiment(file, 0.63, 3, new Date('2026-11-10T10:00:00Z'));
  const later = loadOrStartExperiment(file, -1.5, 3, new Date('2026-11-10T15:00:00Z'));
  assert.deepEqual(later, first, 'the total after some losses is not taken as a new start');
  rmSync(dir, { recursive: true });
});
