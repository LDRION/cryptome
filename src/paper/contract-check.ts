import { readdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { encodeFunctionData, parseAbi, toFunctionSelector, type Abi } from 'viem';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { encodeRun, encodeRunBatch, EXECUTOR, executorCode, hopsOf, NO_GAP_CHECK, SIMULATED_OWNER, SIMULATED_TREASURY, simulateBatch, simulateCycle, type BatchRoute, type RouteHop } from '../executor.ts';
import { createRpc } from '../rpc.ts';
import { sum } from '../stats.ts';
import type { SettledTrade } from './engine.ts';
import { priceOnChain } from './onchain-price.ts';
import type { Universe } from './universe.ts';

/**
 * Must pass before the contract goes anywhere near real money. It runs the real bytecode on
 * real chain state through eth_call, so nothing is deployed and nothing is sent, and exits
 * with an error if the contract lets a stranger in or fails to stop a bad trade.
 */

const { values: args } = parseArgs({ options: { trades: { type: 'string', default: '30' }, file: { type: 'string' } } });

const chain = CHAINS.ethereum!;
const nodeUrl = process.env.TRACE_RPC_URL_ETHEREUM ?? rpcUrlFor(chain);
const rpc = createRpc(nodeUrl, 4);
const artifact = JSON.parse(readFileSync(new URL('../../contracts/Executor.json', import.meta.url), 'utf8')) as { abi: Abi };
const evilPool = JSON.parse(readFileSync(new URL('../../contracts/test/EvilPool.json', import.meta.url), 'utf8')) as { deployedBytecode: string };
const universe = JSON.parse(readFileSync('data/universe-ethereum.json', 'utf8')) as Universe;
const metas = new Map(universe.pools.map((pool) => [pool.address, pool]));
const file = args.file ?? readdirSync('data').filter((f) => /^paper-replay-.*-trades\.jsonl$/.test(f)).sort().at(-1);
if (!file) throw new Error('Нет журнала сделок. Запусти pnpm paper:replay');
const trades = readFileSync(`data/${file}`, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as SettledTrade).slice(0, Number(args.trades));

const STRANGER = '0x000000000000000000000000000000000000dead';
const SIMULATION_GAS = '0x1c9c380';
const ABI = parseAbi([
  'function sweep(address token)',
  'function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes data)',
  'function pancakeV3SwapCallback(int256 amount0, int256 amount1, bytes data)',
  'function unlockCallback(bytes data)',
  'function run(address start, uint256 amountIn, (uint8 kind, address pool, bool zeroForOne, address tokenIn, address tokenOut, uint24 fee, int24 tickSpacing, bool nativeLeg, uint256 priceAtDecision)[] hops, uint256 minProfit, uint256 startGap, uint256 minGap, uint256 targetBlock)',
]);
const WETH = chain.wrappedNative as `0x${string}`;
const failures: string[] = [];
const expect = (ok: boolean, what: string): void => {
  console.log(`  ${ok ? 'ok    ' : 'ПРОВАЛ'} ${what}`);
  if (!ok) failures.push(what);
};

/** A call that must revert. It fails the check if the stranger's call goes through. */
const strangerRefused = async (data: `0x${string}`, tag: string): Promise<boolean> => {
  try {
    await rpc.call('eth_call', [{ from: STRANGER, to: EXECUTOR, data, gas: SIMULATION_GAS }, tag, { [EXECUTOR]: { code: await executorCode(rpc) } }]);
    return false;
  } catch (err) {
    return (err as Error).message.includes('execution reverted');
  }
};

console.log('Доступ посторонних:');
const tag = `0x${trades[0]!.decidedAtBlock.toString(16)}`;
const fn = <T extends Parameters<typeof encodeFunctionData>[0]>(input: T): `0x${string}` => encodeFunctionData(input);
expect(await strangerRefused(fn({ abi: ABI, functionName: 'sweep', args: [WETH] }), tag), 'чужой не может очистить токен');
expect(await strangerRefused(fn({ abi: ABI, functionName: 'sweep', args: ['0x0000000000000000000000000000000000000000'] }), tag), 'чужой не может очистить ETH');
expect(await strangerRefused(fn({ abi: ABI, functionName: 'run', args: [WETH, 1n, [], 0n, 0n, 0n, 0n] }), tag), 'чужой не может запустить сделку');
expect(await strangerRefused(fn({ abi: ABI, functionName: 'uniswapV3SwapCallback', args: [1n, 0n, '0x'] }), tag), 'чужой не может вызвать оплату V3 напрямую');
expect(await strangerRefused(fn({ abi: ABI, functionName: 'pancakeV3SwapCallback', args: [1n, 0n, '0x'] }), tag), 'чужой не может вызвать оплату Pancake напрямую');
expect(await strangerRefused(fn({ abi: ABI, functionName: 'unlockCallback', args: ['0x'] }), tag), 'чужой не может вызвать обратный вызов V4');

const priceOf = (kind: string, zeroForOne: boolean, address: string, blockTag: string): Promise<bigint> => priceOnChain(rpc, kind, zeroForOne, address, blockTag);

console.log(`\nПроверка разрыва до свапа, ${trades.length} сделок из ${file}:`);
const GAP = 2n * 10n ** 16n;
const MIN_GAP = GAP / 2n;
let passedExact = 0;
let failedExact = 0;
let keptSameAmount = 0;
let changedAmount = 0;
let stopped = 0;
let notStopped = 0;
let survivedDrift = 0;
let missedDrift = 0;
let resized = 0;
let notResized = 0;
let staleStopped = 0;
let staleMissed = 0;
const hopsTested: Record<string, number> = {};
const gas: number[] = [];
const checkGas: number[] = [];
/** A price at decision that makes the hop pay this many parts in 10000 worse now than it did then. */
const shifted = (kind: string, zeroForOne: boolean, price: bigint, bps: bigint): bigint => {
  if (kind === 'v2') return (price * (10_000n + bps)) / 10_000n;
  return zeroForOne ? (price * (20_000n + bps)) / 20_000n : (price * (20_000n - bps)) / 20_000n;
};
for (const trade of trades) {
  const blockTag = `0x${trade.decidedAtBlock.toString(16)}`;
  const start = trade.route[0]!;
  const amountIn = BigInt(trade.amountIn);
  const plain = hopsOf(trade.route, trade.pools, metas, chain.wrappedNative);
  const prices = await Promise.all(plain.map((hop, i) => priceOf(hop.kind, hop.zeroForOne, trade.pools[i]!, blockTag)));
  const withRefs = (refs: bigint[]): RouteHop[] => hopsOf(trade.route, trade.pools, metas, chain.wrappedNative, refs);
  const shift = (bps: bigint[]): RouteHop[] => withRefs(prices.map((price, i) => shifted(plain[i]!.kind, plain[i]!.zeroForOne, price, bps[i]!)));

  const baseline = await simulateCycle(rpc, { start, amountIn, hops: plain, blockTag });
  const exact = await simulateCycle(rpc, { start, amountIn, hops: withRefs(prices), blockTag, gap: { startGap: GAP, minGap: MIN_GAP } });
  if (exact.ok) {
    passedExact++;
    gas.push(Number(exact.gasUsed));
    checkGas.push(Number(exact.checkGas));
    if (baseline.ok && baseline.outs[0] === exact.outs[0]) keptSameAmount++;
    else changedAmount++;
  } else {
    failedExact++;
  }
  for (let i = 0; i < plain.length; i++) {
    hopsTested[plain[i]!.kind] = (hopsTested[plain[i]!.kind] ?? 0) + 1;
    // One hop got worse by more than the gap left to give.
    const worse = plain.map((_, j) => (j === i ? 200n : 0n));
    const result = await simulateCycle(rpc, { start, amountIn, hops: shift(worse), blockTag, gap: { startGap: GAP, minGap: MIN_GAP } });
    if (result.ok) notStopped++;
    else stopped++;
  }
  // One hop worse and another better by the same: what stopped trades before, and must not now.
  const drift = plain.map((_, j) => (j === 0 ? 100n : j === 1 ? -100n : 0n));
  const drifted = await simulateCycle(rpc, { start, amountIn, hops: shift(drift), blockTag, gap: { startGap: GAP, minGap: MIN_GAP } });
  if (drifted.ok) survivedDrift++;
  else missedDrift++;
  // A gap narrowed from 2% to about 1% trades about half the amount.
  const narrowed = await simulateCycle(rpc, { start, amountIn, hops: shift(plain.map((_, j) => (j === 0 ? 100n : 0n))), blockTag, gap: { startGap: GAP, minGap: GAP / 4n } });
  if (narrowed.ok && baseline.ok) {
    const share = Number((narrowed.outs[0]! * 1000n) / baseline.outs[0]!);
    if (share > 400 && share < 600) resized++;
    else notResized++;
  } else {
    notResized++;
  }
  const stale = await simulateCycle(rpc, { start, amountIn, hops: plain, blockTag, targetBlock: BigInt(trade.decidedAtBlock + 5) });
  if (stale.ok) staleMissed++;
  else staleStopped++;
}
expect(failedExact === 0, `цены не менялись: проходит ${passedExact} из ${passedExact + failedExact}`);
expect(changedAmount === 0, `цены не менялись: сумма та же в ${keptSameAmount} из ${keptSameAmount + changedAmount}`);
expect(notStopped === 0, `разрыв закрылся из-за одного хода: остановлено ${stopped} из ${stopped + notStopped} ${JSON.stringify(hopsTested)}`);
expect(missedDrift === 0, `цены сдвинулись вместе, разрыв жив: прошло ${survivedDrift} из ${survivedDrift + missedDrift}`);
expect(notResized === 0, `разрыв сузился вдвое, сумма около половины: ${resized} из ${resized + notResized}`);
expect(staleMissed === 0, `не тот блок: остановлено ${staleStopped} из ${staleStopped + staleMissed}`);
if (gas.length > 0) console.log(`\nГаз на сделку: ${Math.round(sum(gas) / gas.length)} в среднем, из них проверка ${Math.round(sum(checkGas) / checkGas.length)}`);

/** Errors the contract can raise, so that a revert names what actually stopped the attack. */
const errorNames = new Map(
  artifact.abi
    .filter((item): item is Extract<Abi[number], { type: 'error' }> => item.type === 'error')
    .map((item) => [toFunctionSelector({ type: 'function', name: item.name, inputs: item.inputs, outputs: [], stateMutability: 'view' }), item.name]),
);

/** Calls with the raw error kept, which the normal client throws away. */
async function rawCall(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message: string; data?: string } }> {
  const response = await fetch(nodeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
  return (await response.json()) as { result?: unknown; error?: { message: string; data?: string } };
}

console.log('\nАтаки вредоносного пула на маршруте:');
const EVIL = '0x00000000000000000000000000000000ee110001';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDC_WETH_POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const hop = (pool: string, zeroForOne: boolean, tokenIn: string, tokenOut: string): RouteHop => ({ kind: 'v3', pool, zeroForOne, tokenIn, tokenOut, fee: 500, tickSpacing: 10, nativeLeg: false, priceAtDecision: 0n });
const route = [hop(EVIL, false, WETH, USDC), hop(USDC_WETH_POOL, true, USDC, WETH)];
const ATTACKS = [
  [1, 'просит вдвое больше положенного'],
  [2, 'просит оплату второй раз'],
  [3, 'лжёт о размере выплаты'],
  [4, 'забирает деньги и ничего не отдаёт'],
  [5, 'вызывает очистку контракта изнутри сделки'],
  [6, 'не берёт деньги и лжёт о выплате'],
] as const;
const attackTag = `0x${trades[0]!.decidedAtBlock.toString(16)}`;
const code = await executorCode(rpc);
for (const [mode, name] of ATTACKS) {
  const overrides = {
    [EXECUTOR]: { code },
    [EVIL]: { code: evilPool.deployedBytecode, stateDiff: { [`0x${'0'.repeat(64)}`]: `0x${mode.toString(16).padStart(64, '0')}` } },
  };
  const call = { from: SIMULATED_OWNER, to: EXECUTOR, gas: SIMULATION_GAS, data: encodeRun(WETH, 10n ** 18n, route, 0n) };
  const answer = await rawCall('eth_call', [call, attackTag, overrides]);
  const blocked = answer.error !== undefined && answer.error.message.includes('reverted');
  const stoppedBy = errorNames.get((answer.error?.data ?? '').slice(0, 10) as `0x${string}`) ?? (answer.error?.data ? 'откат в токене или пуле' : 'откат');
  expect(blocked, `пул ${name}: ${blocked ? `остановлено, ${stoppedBy}` : 'АТАКА ПРОШЛА'}`);
}

console.log('\nВредоносный токен на маршруте:');
const evilToken = JSON.parse(readFileSync(new URL('../../contracts/test/EvilToken.json', import.meta.url), 'utf8')) as { deployedBytecode: string };
const EVIL_TOKEN = '0x00000000000000000000000000000000ee110002';
const tokenRoute = [hop(EVIL_TOKEN, false, WETH, EVIL_TOKEN), hop(EVIL_TOKEN, true, EVIL_TOKEN, WETH)];
// The token hands the money back only if all its calls into the contract were refused.
const tokenAttack = await simulateCycle(rpc, { start: WETH, amountIn: 10n ** 18n, hops: tokenRoute, blockTag: attackTag, overrides: { [EVIL_TOKEN]: { code: evilToken.deployedBytecode } } });
expect(tokenAttack.ok && tokenAttack.profit === 0n, `токен из своего transfer пробует очистку, оплату, обратный вызов и запуск сделки: ${tokenAttack.ok ? 'все 6 попыток отклонены' : `провал: ${tokenAttack.reason}`}`);

console.log('\nКуда уходит прибыль:');
const TRANSFER = '0xa9059cbb';
interface Frame {
  to?: string;
  input?: string;
  calls?: Frame[];
}
const paysTreasury = (frame: Frame, token: string): boolean =>
  (frame.to?.toLowerCase() === token && (frame.input ?? '').startsWith(TRANSFER) && (frame.input ?? '').slice(10, 74).endsWith(SIMULATED_TREASURY.slice(2))) || (frame.calls ?? []).some((inner) => paysTreasury(inner, token));
const sample = trades[0]!;
const traced = await rawCall('debug_traceCall', [
  { from: SIMULATED_OWNER, to: EXECUTOR, gas: SIMULATION_GAS, data: encodeRun(sample.route[0]!, BigInt(sample.amountIn), hopsOf(sample.route, sample.pools, metas, chain.wrappedNative), 0n) },
  `0x${sample.decidedAtBlock.toString(16)}`,
  { tracer: 'callTracer', stateOverrides: { [EXECUTOR]: { code } } },
]);
if (traced.result) expect(paysTreasury(traced.result as Frame, sample.route[0]!), 'прибыль настоящей сделки уходит на холодный адрес');
else console.log(`  не проверено, узел не дал трассировку: ${traced.error?.message.slice(0, 80)}`);

console.log('\nНесколько маршрутов в одной транзакции:');
const ROUTE_GAS = 2_000_000n;
const routeOf = (trade: SettledTrade, gasLimit = ROUTE_GAS): BatchRoute => ({ start: trade.route[0]!, amountIn: BigInt(trade.amountIn), hops: hopsOf(trade.route, trade.pools, metas, chain.wrappedNative), minProfit: 0n, ...NO_GAP_CHECK, gasLimit });
const good = routeOf(sample);
const sampleTag = `0x${sample.decidedAtBlock.toString(16)}`;
const hostile: BatchRoute = { start: WETH, amountIn: 10n ** 18n, hops: route, minProfit: 0n, ...NO_GAP_CHECK, gasLimit: ROUTE_GAS };
const evilAt = (mode: number): Record<string, unknown> => ({ [EVIL]: { code: evilPool.deployedBytecode, stateDiff: { [`0x${'0'.repeat(64)}`]: `0x${mode.toString(16).padStart(64, '0')}` } } });
const worked = (result: Awaited<ReturnType<typeof simulateBatch>>, count: bigint): boolean => result.ok && result.succeeded === count;

expect(await strangerRefused(encodeRunBatch([good]), sampleTag), 'чужой не может запустить пакет');
expect(worked(await simulateBatch(rpc, { routes: [good], blockTag: sampleTag }), 1n), 'один маршрут проходит');
for (const [mode, name] of ATTACKS) {
  const result = await simulateBatch(rpc, { routes: [hostile, good], blockTag: sampleTag, overrides: evilAt(mode) });
  expect(worked(result, 1n), `пул ${name}: отменён только его маршрут, следующий выполнен`);
}
expect(worked(await simulateBatch(rpc, { routes: [routeOf(sample, 40_000n), good], blockTag: sampleTag }), 1n), 'маршрут, исчерпавший свой лимит газа, не мешает следующему');
expect(!(await simulateBatch(rpc, { routes: [hostile], blockTag: sampleTag, overrides: evilAt(1) })).ok, 'когда не сработало ничего, транзакция откатывается');
expect(!(await simulateBatch(rpc, { routes: [good], blockTag: sampleTag, targetBlock: BigInt(sample.decidedAtBlock + 5) })).ok, 'пакет не для этого блока откатывается');

const overlaps = (a: SettledTrade, b: SettledTrade): boolean => a.pools.some((pool) => b.pools.includes(pool));
const pair = trades.flatMap((a) => trades.filter((b) => b.decidedAtBlock === a.decidedAtBlock && b !== a && !overlaps(a, b)).map((b) => [a, b] as const))[0];
if (pair) {
  const tagOfPair = `0x${pair[0].decidedAtBlock.toString(16)}`;
  expect(worked(await simulateBatch(rpc, { routes: [routeOf(pair[0]), routeOf(pair[1])], blockTag: tagOfPair }), 2n), 'два непересекающихся маршрута одного блока проходят оба');
} else {
  console.log('  не проверено: в этих сделках нет двух непересекающихся маршрутов одного блока');
}

const tracedBatch = await rawCall('debug_traceCall', [{ from: SIMULATED_OWNER, to: EXECUTOR, gas: SIMULATION_GAS, data: encodeRunBatch([good]) }, sampleTag, { tracer: 'callTracer', stateOverrides: { [EXECUTOR]: { code } } }]);
if (tracedBatch.result) expect(paysTreasury(tracedBatch.result as Frame, sample.route[0]!), 'прибыль пакета уходит на холодный адрес');
else console.log(`  не проверено, узел не дал трассировку: ${tracedBatch.error?.message.slice(0, 80)}`);

if (failures.length > 0) {
  console.error(`\nКОНТРАКТ НЕ ГОТОВ, проблем: ${failures.length}`);
  process.exitCode = 1;
} else {
  console.log('\nВсе проверки пройдены. Это не аудит: ошибки в логике контракта всё ещё возможны.');
}
