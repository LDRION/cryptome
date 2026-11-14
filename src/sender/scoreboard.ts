import { readdirSync, readFileSync } from 'node:fs';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { blockKind } from '../paper/proposers.ts';
import { createRpc, mapLimit } from '../rpc.ts';
import { SHOTS_NEEDED, VERDICT_TEXT, verdictOf } from './shots.ts';

/**
 * Counts where the real attempts really went, across every run so far, and applies the rule. It
 * only reads. An attempt counts as a shot if the block it aimed at turned out to be self-built:
 * nobody can aim at those in advance, which is why attempts go out for every block.
 */

interface Sent {
  event: 'sent';
  hash: string;
  targetBlock: number;
  routes?: number;
  profitUsd: number;
}

interface Settled {
  event: 'settled';
  hash: string;
  kind: string;
  netUsd?: number;
  costUsd?: number;
}

const rpc = createRpc(process.env.TRACE_RPC_URL_ETHEREUM ?? rpcUrlFor(CHAINS.ethereum!), 3, 15_000);
const events = readdirSync('data')
  .filter((file) => file.endsWith('-real-live-sender.jsonl'))
  .sort()
  .flatMap((file) => readFileSync(`data/${file}`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Sent | Settled | { event: string }));
const sent = events.filter((event): event is Sent => event.event === 'sent');
const settled = new Map(events.filter((event): event is Settled => event.event === 'settled').map((event) => [event.hash, event]));

const rows = await mapLimit(sent, 4, async (attempt) => {
  const [block, receipt] = await Promise.all([
    rpc.call<{ extraData: string }>('eth_getBlockByNumber', [`0x${attempt.targetBlock.toString(16)}`, false]).catch(() => null),
    rpc.call<{ blockNumber: string }>('eth_getTransactionReceipt', [attempt.hash]).catch(() => null),
  ]);
  const result = settled.get(attempt.hash);
  return {
    attempt,
    kind: block ? blockKind(block.extraData) : null,
    onTarget: receipt ? Number(BigInt(receipt.blockNumber)) === attempt.targetBlock : false,
    won: result?.kind === 'won' && (result.netUsd ?? 0) > 0,
    netUsd: result?.kind === 'won' ? (result.netUsd ?? 0) : -(result?.costUsd ?? 0),
  };
});

const known = rows.filter((row) => row.kind !== null);
const shots = known.filter((row) => row.kind === 'validator' || row.kind === 'blank');
const wins = shots.filter((row) => row.won);
const money = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const total = rows.reduce((sum, row) => sum + row.netUsd, 0);

console.log(`Всего попыток: ${rows.length}. Побед: ${rows.filter((row) => row.won).length}. Итог по сделкам: ${money(total)}`);
console.log(`Целились в блоки билдеров: ${known.length - shots.length}, из них выиграно ${known.filter((row) => row.won && !shots.includes(row)).length}`);
console.log(`Целились в блоки валидаторов: ${shots.length} из ${SHOTS_NEEDED}, вошли точно в свой блок ${shots.filter((row) => row.onTarget).length}, выиграно ${wins.length}`);
for (const row of shots) console.log(`  блок ${row.attempt.targetBlock}: маршрутов ${row.attempt.routes ?? 1}, ждали ${money(row.attempt.profitUsd)}, ${row.onTarget ? 'вошла в блок' : 'не вошла в блок'}, итог ${money(row.netUsd)}`);
if (known.length < rows.length) console.log(`Не удалось прочитать блок для ${rows.length - known.length} попыток, запусти ещё раз.`);
console.log(`\n${VERDICT_TEXT[verdictOf(shots.length, wins.length)]}`);
process.exit(0);
