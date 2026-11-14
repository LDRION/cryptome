import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { spotUsd } from './prices.ts';
import { createRpc, mapLimit } from './rpc.ts';
import { quantile, sum } from './stats.ts';
import { detectSolanaArb, type SolanaTx, type TokenBalance } from './solana.ts';

/** Samples recent Solana blocks and measures what atomic arbitrage bots really keep. */

const { values: args } = parseArgs({
  options: {
    rpc: { type: 'string', default: process.env.RPC_URL_SOLANA ?? 'https://api.mainnet-beta.solana.com' },
    blocks: { type: 'string', default: '150' },
    'span-slots': { type: 'string', default: '9000' },
    concurrency: { type: 'string', default: '2' },
  },
});

const MAX_TX_VERSION = 1;
/** Stablecoins are priced at a dollar. Profit in anything else counts as nothing, understating it. */
const USD_MINTS: ReadonlySet<string> = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

interface RawInstruction {
  programIdIndex: number;
}
interface RawTx {
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: { instructions: RawInstruction[] }[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: RawInstruction[] } };
}

const rpc = createRpc(args.rpc, 6);
const solUsd = await spotUsd('solana');
const head = await rpc.call<number>('getSlot', [{ commitment: 'finalized' }]);
const span = Number(args['span-slots']);
const total = Number(args.blocks);
const slots = Array.from({ length: total }, (_, i) => head - 10 - Math.floor((i * span) / total));

const toTx = (raw: RawTx): SolanaTx | null => {
  if (!raw.meta) return null;
  const { message } = raw.transaction;
  const accountKeys = [...message.accountKeys, ...(raw.meta.loadedAddresses?.writable ?? []), ...(raw.meta.loadedAddresses?.readonly ?? [])];
  const programs = new Set<string>();
  const addProgram = (instruction: RawInstruction): void => {
    const program = accountKeys[instruction.programIdIndex];
    if (program) programs.add(program);
  };
  message.instructions.forEach(addProgram);
  for (const inner of raw.meta.innerInstructions ?? []) inner.instructions.forEach(addProgram);
  return {
    signer: message.accountKeys[0]!,
    accountKeys,
    fee: raw.meta.fee,
    signatures: raw.transaction.signatures.length,
    failed: raw.meta.err !== null,
    preBalances: raw.meta.preBalances,
    postBalances: raw.meta.postBalances,
    preTokenBalances: raw.meta.preTokenBalances ?? [],
    postTokenBalances: raw.meta.postTokenBalances ?? [],
    programs,
  };
};

interface Bot {
  wins: number;
  grossUsd: number;
  tipUsd: number;
  feeUsd: number;
  failedFeeUsd: number;
}
const bots = new Map<string, Bot>();
const bot = (signer: string): Bot => {
  let known = bots.get(signer);
  if (!known) bots.set(signer, (known = { wins: 0, grossUsd: 0, tipUsd: 0, feeUsd: 0, failedFeeUsd: 0 }));
  return known;
};

let read = 0;
let skipped = 0;
let transactions = 0;
let unpriced = 0;
const retained: number[] = [];
const hits: { signature: string; slot: number; signer: string; grossUsd: number; tipUsd: number; feeUsd: number; pools: number }[] = [];
const failedBySigner = new Map<string, number>();
const skipReasons = new Map<string, number>();

await mapLimit(slots, Number(args.concurrency), async (slot) => {
  let block: { transactions: RawTx[] };
  try {
    block = await rpc.call('getBlock', [slot, { encoding: 'json', maxSupportedTransactionVersion: MAX_TX_VERSION, rewards: false, transactionDetails: 'full' }]);
  } catch (err) {
    // Skipped slots have no block, and public nodes refuse some requests under load.
    skipped++;
    const reason = (err as Error).message.slice(0, 90);
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    return;
  }
  read++;
  transactions += block.transactions.length;
  for (const raw of block.transactions) {
    const tx = toTx(raw);
    if (!tx) continue;
    if (tx.failed) {
      failedBySigner.set(tx.signer, (failedBySigner.get(tx.signer) ?? 0) + (tx.fee / 1e9) * solUsd);
      continue;
    }
    const hit = detectSolanaArb(tx);
    if (!hit) continue;
    const grossUsd = hit.gainAsset === 'SOL' ? hit.gain * solUsd : USD_MINTS.has(hit.gainAsset) ? hit.gain : 0;
    if (grossUsd === 0) {
      unpriced++;
      continue;
    }
    const tipUsd = (hit.tipLamports / 1e9) * solUsd;
    const feeUsd = (tx.fee / 1e9) * solUsd;
    const entry = bot(hit.signer);
    entry.wins++;
    entry.grossUsd += grossUsd;
    entry.tipUsd += tipUsd;
    entry.feeUsd += feeUsd;
    retained.push(grossUsd - tipUsd - feeUsd);
    hits.push({ signature: raw.transaction.signatures[0]!, slot, signer: hit.signer, grossUsd, tipUsd, feeUsd, pools: hit.pools });
  }
  if (read % 25 === 0) console.error(`  ${read}/${total} blocks`);
});

for (const [reason, count] of skipReasons) console.error(`  пропущено ${count}: ${reason}`);
if (read === 0) throw new Error('No block could be read, so this run measured nothing');

for (const [signer, fee] of failedBySigner) {
  const known = bots.get(signer);
  if (known) known.failedFeeUsd += fee;
}

const list = [...bots].map(([signer, b]) => ({ signer, ...b, keptUsd: b.grossUsd - b.tipUsd - b.feeUsd - b.failedFeeUsd })).sort((a, b) => b.keptUsd - a.keptUsd);
const gross = sum(list.map((b) => b.grossUsd));
const tips = sum(list.map((b) => b.tipUsd));
const fees = sum(list.map((b) => b.feeUsd));
const failed = sum(list.map((b) => b.failedFeeUsd));
const kept = gross - tips - fees - failed;
// Slots got shorter than the 0.4 s everyone quotes, so the network is asked how long they are now.
const samples = await rpc.call<{ numSlots: number; samplePeriodSecs: number }[]>('getRecentPerformanceSamples', [10]);
const slotSeconds = sum(samples.map((sample) => sample.samplePeriodSecs)) / sum(samples.map((sample) => sample.numSlots));
const chainSeconds = read * slotSeconds;
const perDay = (x: number): number => (chainSeconds > 0 ? (x / chainSeconds) * 86_400 : 0);
const money = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(Math.abs(x) < 10 ? 3 : 0)}`;

console.log(`\n[solana] ${read} blocks read of ${total}, skipped ${skipped}, ${transactions} transactions, ${chainSeconds.toFixed(0)} s of chain time, SOL ${money(solUsd)}`);
console.log(`Arbitrages ${retained.length}, not priced ${unpriced}`);
console.log(`Gross ${money(gross)} | Jito tips ${money(tips)} (${gross > 0 ? ((tips / gross) * 100).toFixed(0) : '-'}%) | fees ${money(fees)} | same bots' failed tx fees ${money(failed)} | kept ${money(kept)}`);
console.log(`Per day, rough: gross ${money(perDay(gross))}, kept ${money(perDay(kept))}`);
console.log(`Per win kept: median ${money(quantile(retained, 0.5))}, p90 ${money(quantile(retained, 0.9))}, max ${money(quantile(retained, 1))}`);
console.log(`Bots ${list.length}, profitable ${list.filter((b) => b.keptUsd > 0).length}. Top: ${list.slice(0, 6).map((b) => `${b.signer.slice(0, 6)} ${b.wins}x ${money(b.keptUsd)}`).join(', ')}`);
const top = sum(list.slice(0, 1).map((b) => b.keptUsd));
console.log(`Top bot share of what profitable bots keep: ${(() => {
  const positive = sum(list.filter((b) => b.keptUsd > 0).map((b) => b.keptUsd));
  return positive > 0 ? `${((top / positive) * 100).toFixed(0)}%` : '-';
})()}`);

await mkdir('data', { recursive: true });
await writeFile(`data/solana-${new Date().toISOString().replaceAll(':', '-')}.json`, JSON.stringify({ read, skipped, chainSeconds, solUsd, gross, tips, fees, failed, kept, bots: list, hits: [...hits].sort((a, b) => b.grossUsd - a.grossUsd) }, null, 2));
