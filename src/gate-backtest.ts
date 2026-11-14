import { readdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { decide, type RefusalReason } from './gate.ts';
import { sum } from './stats.ts';

/**
 * Runs the gate over landed trades using their real outcomes as inputs. This checks the
 * rule and prices its caution. It cannot show predictive skill, because a live gate only
 * has a simulated estimate of these numbers.
 */

const { values: args } = parseArgs({ options: { chain: { type: 'string', default: 'ethereum' } } });

const file = (await readdir('data')).filter((f) => f.startsWith(`payments-${args.chain}-`)).sort().at(-1);
if (!file) throw new Error(`No payments data for ${args.chain}`);

interface TracedHit {
  grossUsd: number;
  minerUsd: number;
  gasUsd: number;
  retainedUsd: number;
  failed: boolean;
  excluded: boolean;
}
const data = JSON.parse(await readFile(`data/${file}`, 'utf8')) as { hits: TracedHit[] };
const hits = data.hits.filter((h) => !h.failed && !h.excluded);

const rows = [undefined, 0, 0.1, 0.2, 0.3].map((haircut) => {
  const reasons = new Map<RefusalReason, number>();
  const sent: TracedHit[] = [];
  const refused: TracedHit[] = [];
  for (const hit of hits) {
    if (haircut === undefined) {
      sent.push(hit);
      continue;
    }
    const decision = decide(
      {
        simulatedProfitUsd: hit.grossUsd,
        gasUsd: hit.gasUsd,
        builderPaymentUsd: hit.minerUsd,
        failureGasUsd: 0,
        winProbability: 1,
        stateAgeMs: 0,
        routeVetted: true,
        mode: 'revert-protected',
      },
      { profitHaircut: haircut, minNetUsd: 0.01, minExpectedValueUsd: 0, maxStateAgeMs: 50, remainingLossBudgetUsd: 0 },
    );
    if (decision.send) {
      sent.push(hit);
    } else {
      refused.push(hit);
      reasons.set(decision.reason, (reasons.get(decision.reason) ?? 0) + 1);
    }
  }
  return {
    gate: haircut === undefined ? 'none' : `haircut ${haircut * 100}%`,
    sent: sent.length,
    refused: refused.length,
    losingSent: sent.filter((h) => h.retainedUsd < 0).length,
    lossSent: +sum(sent.filter((h) => h.retainedUsd < 0).map((h) => h.retainedUsd)).toFixed(2),
    netSent: +sum(sent.map((h) => h.retainedUsd)).toFixed(2),
    profitSkipped: +sum(refused.filter((h) => h.retainedUsd > 0).map((h) => h.retainedUsd)).toFixed(2),
  };
});

console.log(`[${args.chain}] ${hits.length} landed trades from ${file}`);
console.table(rows);
