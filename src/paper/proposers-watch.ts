import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { createRpc } from '../rpc.ts';
import { addPrediction, blockKind, fetchRelayList, newPredictionStats, predictionQuality, recipientsBySlot, RELAYS, registeredSlots, SLOTS_PER_EPOCH, slotOf } from './proposers.ts';

/** Predicts self-built blocks from relay registrations, then compares with what each block was. */

const { values: args } = parseArgs({
  options: {
    hours: { type: 'string', default: '6' },
    'min-relays': { type: 'string', default: '4' },
    'poll-ms': { type: 'string', default: '4000' },
  },
});

const REFRESH_MS = (SLOTS_PER_EPOCH * 12 * 1000) / 2;

const rpc = createRpc(rpcUrlFor(CHAINS.ethereum!));
const stats = newPredictionStats();
const startedAt = new Date().toISOString().replaceAll(':', '-');
const stem = `data/proposers-${startedAt}`;
await mkdir('data', { recursive: true });

let registered = new Set<number>();
const recipients = new Map<number, string>();
let relaysAnswering = 0;
let coveredUpTo = 0;

const refresh = async (): Promise<void> => {
  const answers = (await Promise.all(RELAYS.map((relay) => fetchRelayList(relay)))).filter((list) => list !== null);
  relaysAnswering = answers.length;
  if (answers.length === 0) return;
  const slots = registeredSlots(answers);
  for (const slot of registered) slots.add(slot);
  registered = slots;
  for (const [slot, recipient] of recipientsBySlot(answers)) recipients.set(slot, recipient);
  coveredUpTo = Math.max(coveredUpTo, ...slots);
};

await refresh();
console.error(`Реле ответили: ${relaysAnswering} из ${RELAYS.length}. Данные до слота ${coveredUpTo}`);
let lastRefresh = Date.now();
const firstSlot = coveredUpTo - SLOTS_PER_EPOCH * 2;
const deadline = Date.now() + Number(args.hours) * 3_600_000;
const minRelays = Number(args['min-relays']);

let next = Number(BigInt(await rpc.call<string>('eth_blockNumber', [])));
let compared = 0;
let stop = false;
process.on('SIGINT', () => {
  stop = true;
});

const report = (): string => {
  const quality = predictionQuality(stats);
  return `сравнено ${compared}: предсказано самосборных ${quality.acted}, точность ${(quality.precision * 100).toFixed(0)}%, поймано ${(quality.recall * 100).toFixed(0)}% | ${JSON.stringify(stats)}`;
};

while (!stop && Date.now() < deadline) {
  try {
    if (Date.now() - lastRefresh > REFRESH_MS) {
      await refresh();
      lastRefresh = Date.now();
    }
    const head = Number(BigInt(await rpc.call<string>('eth_blockNumber', [])));
    for (; next <= head; next++) {
      const block = await rpc.call<{ timestamp: string; extraData: string; miner: string }>('eth_getBlockByNumber', [`0x${next.toString(16)}`, false]);
      const slot = slotOf(Number(BigInt(block.timestamp)));
      const kind = blockKind(block.extraData);
      // Lists only look ahead, so a slot before them or too few answers proves nothing.
      if (slot < firstSlot || slot > coveredUpTo || relaysAnswering < minRelays) {
        stats.skipped++;
        continue;
      }
      const predicted = !registered.has(slot);
      addPrediction(stats, predicted, kind);
      compared++;
      await appendFile(`${stem}.jsonl`, `${JSON.stringify({ block: next, slot, predicted, kind, miner: block.miner, recipient: recipients.get(slot) ?? null })}\n`);
      if (compared % 25 === 0) {
        console.error(`  ${report()}`);
        await writeFile(`${stem}.json`, JSON.stringify({ startedAt, relaysAnswering, stats, quality: predictionQuality(stats) }, null, 2));
      }
    }
  } catch (err) {
    console.error(`  сбой, повтор: ${(err as Error).message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, Number(args['poll-ms'])));
}
await writeFile(`${stem}.json`, JSON.stringify({ startedAt, relaysAnswering, stats, quality: predictionQuality(stats) }, null, 2));
console.log(report());
