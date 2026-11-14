import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { decodeRunProfit, encodeRun, EXECUTOR, executorCode, hopsOf, SIMULATED_OWNER } from '../executor.ts';
import { createRpc, mapLimit } from '../rpc.ts';
import { TX_OVERHEAD_GAS } from './chain-view.ts';
import type { SettledTrade } from './engine.ts';
import { priceOnChain } from './onchain-price.ts';
import { poolKeyOf } from './pools.ts';
import type { Universe } from './universe.ts';

/**
 * Checks the emulator's wins in blocks ordered by tip without spending anything. It rebuilds each
 * real block in a real EVM: the parent's state, every transaction that paid more than we would,
 * in their real order, and then the real contract. What the contract does at that point is what
 * it would have done had the attempt been there.
 *
 * This assumes our transaction would have been included at its tip, which only a real attempt can
 * show, and it does not know which of those rivals were visible when we would have sent.
 */

const { values: args } = parseArgs({ options: { file: { type: 'string' }, concurrency: { type: 'string', default: '3' }, 'min-net': { type: 'string', default: '0.25' } } });

const MIN_TIP_WEI = 100_000_000n;
const FAILED_OVERHEAD_GAS = 30_000n;
const MAX_RIVAL_TIPS = 4;
/** About 8% of attempts aim at a self-built block, so each one comes with this many others. */
const OTHER_BLOCKS_PER_SELF_BUILT = 11.5;
const SIMULATION_GAS = '0x1c9c380';
const chain = CHAINS.ethereum!;
const rpc = createRpc(process.env.TRACE_RPC_URL_ETHEREUM ?? rpcUrlFor(chain), 4, 60_000);
const universe = JSON.parse(readFileSync('data/universe-ethereum.json', 'utf8')) as Universe;
const metas = new Map(universe.pools.map((pool) => [pool.address, pool]));
const file = args.file ?? readdirSync('data').filter((f) => /^paper-replay-.*-trades\.jsonl$/.test(f)).sort().at(-1)!;
const trades = readFileSync(`data/${file}`, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as SettledTrade);
const inTipOrder = trades.filter((trade) => trade.atOurTurn);
const days = ((Math.max(...trades.map((t) => t.targetBlock)) - Math.min(...trades.map((t) => t.targetBlock))) * 12) / 86_400;
const minNet = Number(args['min-net']);
const tagOf = (n: number): string => `0x${n.toString(16)}`;

interface BlockTx {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  gas: string;
  type: string;
}
interface FullBlock {
  baseFeePerGas: string;
  timestamp: string;
  miner: string;
  gasLimit: string;
  transactions: BlockTx[];
}
interface BlockReceipt {
  transactionHash: string;
  gasUsed: string;
  effectiveGasPrice: string;
  logs?: { address: string; topics: string[]; data: string }[];
}
interface SimulatedCall {
  status: string;
  gasUsed?: string;
  returnData?: string;
  error?: { message?: string; data?: string };
}

const code = await executorCode(rpc);

const blocks = new Map<number, Promise<{ block: FullBlock; receipts: Map<string, BlockReceipt> }>>();
const blockOf = (n: number): Promise<{ block: FullBlock; receipts: Map<string, BlockReceipt> }> => {
  let known = blocks.get(n);
  if (!known) {
    known = Promise.all([rpc.call<FullBlock>('eth_getBlockByNumber', [tagOf(n), true]), rpc.call<BlockReceipt[]>('eth_getBlockReceipts', [tagOf(n)])]).then(([block, receipts]) => ({ block, receipts: new Map(receipts.map((r) => [r.transactionHash, r])) }));
    blocks.set(n, known);
  }
  return known;
};

const simulate = async (calls: Record<string, string>[], parent: number, block: FullBlock): Promise<SimulatedCall[]> => {
  const overrides = { number: tagOf(parent + 1), time: block.timestamp, feeRecipient: block.miner, baseFeePerGas: block.baseFeePerGas, gasLimit: block.gasLimit };
  const answer = await rpc.call<{ calls: SimulatedCall[] }[]>('eth_simulateV1', [{ blockStateCalls: [{ blockOverrides: overrides, stateOverrides: { [EXECUTOR]: { code } }, calls }], validation: false }, tagOf(parent)]);
  return answer[0]?.calls ?? [];
};

const results = await mapLimit(inTipOrder, Number(args.concurrency), async (trade) => {
  try {
    const { block, receipts } = await blockOf(trade.targetBlock);
    const base = BigInt(block.baseFeePerGas);
    const parent = trade.decidedAtBlock;
    const plain = hopsOf(trade.route, trade.pools, metas, chain.wrappedNative);
    const prices = await Promise.all(plain.map((hop, i) => priceOnChain(rpc, hop.kind, hop.zeroForOne, trade.pools[i]!, tagOf(parent))));
    const hops = hopsOf(trade.route, trade.pools, metas, chain.wrappedNative, prices);
    const turn = trade.atOurTurn!;
    const startGap = BigInt(Math.floor((turn.startEdge - 1) * 1e18));

    const units = BigInt(trade.gasUnits);
    const nativeUsd = trade.gasUsd / ((Number(units) * Number(base)) / 1e18);
    const bidTip = BigInt(Math.ceil(((trade.bidUsd / nativeUsd) * 1e18) / Number(units)));
    const tip = bidTip > MIN_TIP_WEI ? bidTip : MIN_TIP_WEI;
    const usdOfGas = (gas: bigint, atTip: bigint): number => (Number(gas * (base + atTip)) / 1e18) * nativeUsd;
    const neededAt = (atTip: bigint): number => usdOfGas(units, atTip) + minNet;
    // The sender works this out in advance and would not have sent it at all.
    if (trade.profitUsd < neededAt(tip)) return { block: trade.targetBlock, ahead: 0, plannedUsd: trade.profitUsd, profitUsd: 0, modelUsd: trade.results.realistic.netUsd, netUsd: 0, bestUsd: 0, expectedUsd: 0, raisedToGwei: null, outcome: 'not-sent', reason: null, gasUsed: 0 };

    const call = (gap: { startGap: bigint; minGap: bigint }): Record<string, string> => ({ from: SIMULATED_OWNER, to: EXECUTOR, gas: SIMULATION_GAS, data: encodeRun(trade.route[0]!, BigInt(trade.amountIn), hops, 0n, 0n, gap) });
    const tipOfTx = (tx: BlockTx): bigint | null => {
      const receipt = receipts.get(tx.hash);
      return tx.to !== null && receipt !== undefined ? BigInt(receipt.effectiveGasPrice) - base : null;
    };
    const aheadOf = (atTip: bigint): Record<string, string>[] =>
      block.transactions
        .filter((tx) => {
          const paid = tipOfTx(tx);
          return paid !== null && paid >= atTip;
        })
        .map((tx) => {
          const used = BigInt(receipts.get(tx.hash)!.gasUsed);
          const limit = BigInt(tx.gas);
          const gas = (used * 3n) / 2n + 50_000n;
          return { from: tx.from, to: tx.to!, data: tx.input, value: tx.value, gas: `0x${(gas < limit ? gas : limit).toString(16)}` };
        });

    // The price it was decided on, with nobody ahead, sets the worth of a unit of profit.
    const [alone] = await simulate([call({ startGap, minGap: 0n })], parent, block);
    if (alone?.status !== '0x1' || !alone.returnData) return { block: trade.targetBlock, error: `alone: ${alone?.error?.data ?? alone?.error?.message ?? 'no result'}`, modelUsd: trade.results.realistic.netUsd };
    const aloneProfit = decodeRunProfit(alone.returnData as `0x${string}`);
    const usdPerUnit = trade.profitUsd / Number(aloneProfit);

    const atTip = async (paying: bigint): Promise<{ netUsd: number; profitUsd: number; outcome: string; reason: string | null; gasUsed: bigint; ahead: number }> => {
      const minGap = BigInt(Math.ceil(Number(startGap) * Math.sqrt(Math.min(neededAt(paying) / trade.profitUsd, 1))));
      const calls = aheadOf(paying);
      const ours = (await simulate([...calls, call({ startGap, minGap })], parent, block)).at(-1);
      const gasUsed = BigInt(ours?.gasUsed ?? '0x0');
      const passed = ours?.status === '0x1' && ours.returnData !== undefined;
      const profitUsd = passed ? Number(decodeRunProfit(ours.returnData as `0x${string}`)) * usdPerUnit : 0;
      const fullUsd = usdOfGas(gasUsed + TX_OVERHEAD_GAS, paying);
      if (passed) return profitUsd >= fullUsd + minNet ? { netUsd: profitUsd - fullUsd, profitUsd, outcome: 'won', reason: null, gasUsed, ahead: calls.length } : { netUsd: -fullUsd, profitUsd, outcome: 'unprofitable', reason: null, gasUsed, ahead: calls.length };
      return { netUsd: -usdOfGas(gasUsed + FAILED_OVERHEAD_GAS, paying), profitUsd, outcome: gasUsed < 100_000n ? 'stopped' : 'costly', reason: ours?.error?.data ?? ours?.error?.message ?? 'no result', gasUsed, ahead: calls.length };
    };

    const plain_ = await atTip(tip);

    // Those paying more who touched this route are the bids to beat, seen in the mempool beforehand.
    const pools = new Set(trade.pools);
    const rivals = block.transactions
      .map((tx) => ({ tx, paid: tipOfTx(tx) }))
      .filter((entry): entry is { tx: BlockTx; paid: bigint } => entry.paid !== null && entry.paid >= tip && (receipts.get(entry.tx.hash)!.logs ?? []).some((log) => pools.has(poolKeyOf(log as never))))
      .map((entry) => entry.paid)
      .filter((paid, i, all) => all.indexOf(paid) === i)
      .sort((a, b) => (a < b ? -1 : 1))
      .slice(0, MAX_RIVAL_TIPS);
    const failedAt = (paying: bigint): number => usdOfGas(50_000n, paying);
    let bestUsd = plain_.netUsd;
    let expectedUsd = plain_.netUsd;
    let raisedToGwei: number | null = null;
    for (const rival of rivals) {
      const paying = rival + 1n;
      if (trade.profitUsd < neededAt(paying)) continue;
      const raised = await atTip(paying);
      if (raised.netUsd > bestUsd) bestUsd = raised.netUsd;
      // A higher tip also costs more in every other block, where the attempt usually just fails.
      const expected = raised.netUsd - (failedAt(paying) - failedAt(tip)) * OTHER_BLOCKS_PER_SELF_BUILT;
      if (expected > expectedUsd) {
        expectedUsd = expected;
        raisedToGwei = Number(paying) / 1e9;
      }
    }
    return {
      block: trade.targetBlock,
      ahead: plain_.ahead,
      plannedUsd: trade.profitUsd,
      profitUsd: plain_.profitUsd,
      modelUsd: trade.results.realistic.netUsd,
      netUsd: plain_.netUsd,
      bestUsd,
      expectedUsd,
      raisedToGwei,
      outcome: plain_.outcome,
      reason: plain_.reason,
      gasUsed: Number(plain_.gasUsed),
    };
  } catch (err) {
    return { block: trade.targetBlock, error: (err as Error).message.slice(0, 140), modelUsd: trade.results.realistic.netUsd };
  }
});

const money = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const done = results.filter((r): r is typeof r & { netUsd: number } => 'netUsd' in r);
const failedChecks = results.filter((r) => 'error' in r);
const sum = (a: typeof done, f: (r: (typeof done)[number]) => number): number => a.reduce((s, r) => s + f(r), 0);
console.log(`${file}: ${inTipOrder.length} trades in blocks ordered by tip, checked ${done.length}, could not check ${failedChecks.length}, over ${days.toFixed(2)} days`);
const count: Record<string, number> = {};
for (const r of done) count[r.outcome!] = (count[r.outcome!] ?? 0) + 1;
console.log(`outcomes ${JSON.stringify(count)}`);
console.log(`emulator said ${money(sum(done, (r) => r.modelUsd))} = ${money(sum(done, (r) => r.modelUsd) / days)}/day; rebuilt blocks say ${money(sum(done, (r) => r.netUsd))} = ${money(sum(done, (r) => r.netUsd) / days)}/day`);
const perBlock = new Map<number, number>();
for (const r of done) if (r.netUsd > 0) perBlock.set(r.block, (perBlock.get(r.block) ?? 0) + r.netUsd);
const top = [...perBlock.values()].sort((a, b) => b - a);
console.log(`winning blocks ${top.length}, largest ${top.slice(0, 5).map((v) => v.toFixed(2)).join(', ')}; without the top two ${money((sum(done, (r) => r.netUsd) - (top[0] ?? 0) - (top[1] ?? 0)) / days)}/day`);
const raised = done.filter((r) => r.raisedToGwei !== null);
console.log(`paying just above rivals: knowing every bid ${money(sum(done, (r) => r.bestUsd!))} = ${money(sum(done, (r) => r.bestUsd!) / days)}/day; after a higher tip's cost in the other blocks ${money(sum(done, (r) => r.expectedUsd!))} = ${money(sum(done, (r) => r.expectedUsd!) / days)}/day, raised on ${raised.length} trades`);
for (const r of [...raised].sort((a, b) => b.expectedUsd! - b.netUsd - (a.expectedUsd! - a.netUsd)).slice(0, 8)) console.log(`  ${r.block}: planned ${money(r.plannedUsd!)}, tip raised to ${r.raisedToGwei!.toFixed(3)} gwei, net ${money(r.netUsd)} becomes ${money(r.expectedUsd!)}`);
const differ = [...done].sort((a, b) => Math.abs(b.netUsd - b.modelUsd) - Math.abs(a.netUsd - a.modelUsd)).slice(0, 12);
console.log('largest differences:');
for (const r of differ) console.log(`  ${r.block} ahead ${String(r.ahead).padStart(3)}: planned ${money(r.plannedUsd!)}, got ${money(r.profitUsd!)}, emulator net ${money(r.modelUsd)}, rebuilt net ${money(r.netUsd)}, ${r.outcome}${r.reason ? ` ${r.reason.slice(0, 26)}` : ''}`);
for (const r of failedChecks.slice(0, 6)) console.log(`  could not check ${r.block}: ${'error' in r ? r.error : ''}`);
writeFileSync(`data/turn-proof-${new Date().toISOString().replaceAll(':', '-')}.json`, JSON.stringify(results, null, 2));
process.exit(0);
