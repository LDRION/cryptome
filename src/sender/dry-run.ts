import { appendFile } from 'node:fs/promises';
import type { SentTrade, SettledTrade } from '../paper/engine.ts';
import { planAttempt, type TxPlan } from './plan.ts';
import type { RiskGuard } from './risk.ts';

/**
 * Does everything a real sender would, up to the moment of signing. No key exists here and
 * nothing leaves the machine. It shows what the limits would have done and what each attempt
 * would have cost, using the outcome the emulator gives the trade.
 */

export interface DryRunSummary {
  planned: number;
  refused: Record<string, number>;
  noPlan: number;
  won: number;
  failed: number;
  notIncluded: number;
  netUsd: number;
  failureCostUsd: number;
}

const keyOf = (decidedAtBlock: number, pools: string[]): string => `${decidedAtBlock}:${pools.join()}`;

export class DryRunSender {
  private readonly guard: RiskGuard;
  private readonly file: string;
  private readonly open = new Map<string, TxPlan>();
  readonly summary: DryRunSummary = { planned: 0, refused: {}, noPlan: 0, won: 0, failed: 0, notIncluded: 0, netUsd: 0, failureCostUsd: 0 };

  constructor(guard: RiskGuard, file: string) {
    this.guard = guard;
    this.file = file;
  }

  async propose(trade: SentTrade, context: { nextBaseFeeWei: bigint; nativeUsd: number; timestamp: number; minNetUsd: number; failureGasUnits: bigint }, now: number): Promise<void> {
    const plan = planAttempt({
      profitUsd: trade.profitUsd,
      bidUsd: trade.bidUsd,
      usdPerStartUnit: trade.usdPerUnit,
      gasUnits: trade.gasUnits,
      nextBaseFeeWei: context.nextBaseFeeWei,
      nativeUsd: context.nativeUsd,
      decidedBlockTimestamp: context.timestamp,
      decidedBlock: trade.decidedAtBlock,
      failureGasUnits: context.failureGasUnits,
      minNetUsd: context.minNetUsd,
    });
    if (!plan) {
      this.summary.noPlan++;
      return;
    }
    const verdict = this.guard.check({ pools: trade.pools, failureCostUsd: plan.failureCostUsd }, now);
    if (!verdict.ok) {
      this.summary.refused[verdict.reason] = (this.summary.refused[verdict.reason] ?? 0) + 1;
      await appendFile(this.file, `${JSON.stringify({ event: 'refused', block: trade.decidedAtBlock, reason: verdict.reason, profitUsd: trade.profitUsd })}\n`);
      return;
    }
    this.summary.planned++;
    this.open.set(keyOf(trade.decidedAtBlock, trade.pools), plan);
    await appendFile(
      this.file,
      `${JSON.stringify({ event: 'would-send', block: trade.decidedAtBlock, route: trade.route, pools: trade.pools, amountIn: trade.amountIn.toString(), profitUsd: trade.profitUsd, bidUsd: trade.bidUsd, targetBlock: plan.targetBlock, tipWeiPerGas: plan.tipWeiPerGas.toString(), maxFeePerGas: plan.maxFeePerGas.toString(), gasLimit: plan.gasLimit.toString(), minProfitUnits: plan.minProfitUnits.toString(), pricesAtDecision: trade.pricesAtDecision.map(String), startGap: trade.startGap.toString(), failureCostUsd: plan.failureCostUsd, sendAtMs: plan.sendAtMs })}\n`,
    );
  }

  /** Attempts the limits refused never went out, so their outcome does not count. */
  async settle(trade: SettledTrade, now: number): Promise<void> {
    const key = keyOf(trade.decidedAtBlock, trade.pools);
    const plan = this.open.get(key);
    if (!plan) return;
    this.open.delete(key);
    const { outcome, netUsd } = trade.results.realistic;
    if (outcome === 'won') {
      this.summary.won++;
      this.summary.netUsd += netUsd;
      this.guard.record({ kind: 'won', netUsd }, now);
    } else if (outcome === 'not-included') {
      this.summary.notIncluded++;
      this.guard.record({ kind: 'not-included' }, now);
    } else {
      this.summary.failed++;
      this.summary.netUsd -= plan.failureCostUsd;
      this.summary.failureCostUsd += plan.failureCostUsd;
      this.guard.record({ kind: 'stopped-early', costUsd: plan.failureCostUsd }, now);
    }
    await appendFile(this.file, `${JSON.stringify({ event: 'settled', block: trade.decidedAtBlock, outcome, netUsd: outcome === 'won' ? netUsd : -plan.failureCostUsd, dayNetUsd: this.guard.state.dayNetUsd, totalNetUsd: this.guard.state.totalNetUsd })}\n`);
  }
}
