import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { nextBaseFee } from '../amm.ts';
import { bindOutgoing, directAddress, stillHere } from '../net.ts';
import { createPriceReader, type MajorPrices } from '../prices.ts';
import { privateKeyToAccount } from 'viem/accounts';
import { deployedMatchesBuild } from '../executor.ts';
import { PUBLIC_NODES } from '../sender/broadcast.ts';
import { checkAtTopOfBlock } from '../sender/bundle-check.ts';
import { BUILDER_ENDPOINTS, sendBundle, traceAtEureka, type BundleAnswer } from '../sender/bundles.ts';
import { loadSlotOdds } from '../sender/odds.ts';
import { GasWatch } from '../sender/results.ts';
import { DryRunSender } from '../sender/dry-run.ts';
import { LiveSender, REQUIRED_CONFIRMATION } from '../sender/live.ts';
import { experimentLimits, loadOrStartExperiment } from '../sender/experiment.ts';
import { DEFAULT_LIMITS, newRiskState, RiskGuard, type RiskState } from '../sender/risk.ts';
import { createRpc, mapLimit, type Rpc } from '../rpc.ts';
import { quantile } from '../stats.ts';
import { Archive, archiveDir, lastCompleteBlock, type Chunk } from './archive.ts';
import { createChainView } from './chain-view.ts';
import { Foresight, type PendingCall } from './foresight.ts';
import { loadDepths } from './depth.ts';
import { PaperEngine, type BlockHeader, type EngineConfig, type Prices } from './engine.ts';
import { fetchBlockLogs, fetchRangeLogs } from './feed.ts';
import { Memo, memoizedRpc } from './memo.ts';
import { poolKeyOf, STATE_TOPICS, SWAP_TOPICS, V4_POOL_MANAGER, type PoolLog } from './pools.ts';
import { addWin, newRecallStats, winWasFound, type RecallStats } from './recall.ts';
import { formatReport, type PaperSummary } from './report.ts';
import { blockKind, fetchRelayList, RELAYS, SLOTS_PER_EPOCH, slotOf, type BlockKind } from './proposers.ts';
import { createRivalLookup, createTipLookup } from './rivals.ts';
import { addGap, connectStreams, newVisibilityStats, PendingTracker, type Visibility, type VisibilityStats } from './streams.ts';
import type { Universe } from './universe.ts';

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'replay' },
    blocks: { type: 'string', default: '7200' },
    from: { type: 'string' },
    to: { type: 'string' },
    warmup: { type: 'string', default: '2000' },
    concurrency: { type: 'string', default: '6' },
    label: { type: 'string' },
    'no-evm': { type: 'boolean', default: false },
    'skip-mid-block': { type: 'boolean', default: false },
    'all-builders': { type: 'boolean', default: false },
    universe: { type: 'string', default: 'data/universe-ethereum.json' },
    // Trades only blocks that validators build themselves, through the public mempool.
    'self-built': { type: 'boolean', default: false },
    'include-blank': { type: 'boolean', default: false },
    'scan-inside': { type: 'boolean', default: false },
    // Sends a public transaction for every block instead of guessing which ones are self-built.
    'public-always': { type: 'boolean', default: false },
    'dry-send': { type: 'boolean', default: false },
    'live-send': { type: 'boolean', default: false },
    // Runs pending transactions in advance and logs what they would open. Sends nothing.
    foresee: { type: 'boolean', default: false },
    'loss-budget': { type: 'string', default: '5' },
    'bid-share': { type: 'string', default: '0.85' },
    haircut: { type: 'string', default: '0.1' },
    'min-net': { type: 'string', default: '1' },
    // Every trade found goes out publicly in every slot, until this much is lost from the experiment's start.
    'every-block': { type: 'boolean', default: false },
    'experiment-loss': { type: 'string', default: '3' },
    // Within the experiment, public attempts only where the block is at least this likely to be self-built.
    'min-own-chance': { type: 'string' },
    infra: { type: 'string', default: '30' },
    balance: { type: 'string', default: '1000' },
    'poll-ms': { type: 'string', default: '3000' },
    'max-minutes': { type: 'string' },
    'one-tick': { type: 'boolean', default: false },
  },
});

const HEADER_CONCURRENCY = 4;
const PRICE_REFRESH_BLOCKS = 300;
const SAVE_EVERY_BLOCKS = 25;
const DECIMALS = '0x313ce567';
const BLOCK_TIME = 12;
const RPC_FAILURE_WAIT_MS = 1000;
const MIN_LOGGED_GAP_USD = 1;
/** Deep enough that a stored block will never be replaced by a reorganisation. */
const SETTLED_BLOCKS = 64;
/** How often the reading of pool depth is redone, because prices drift out of its range. */
const DEPTH_REFRESH_BLOCKS = 1800;
/**
 * Burned by an attempt that stops at its price check, before any swap: the base cost of 21k,
 * calldata and the check itself, which real state puts at 15-22k. About 48-58k in all.
 */
const FAILED_CHECK_GAS = 60_000n;
/** Left in the sender's balance so that a stuck attempt can always be replaced. */
const LIVE_SENDER_RESERVE_WEI = 200_000_000_000_000n;

const isReplay = args.mode === 'replay';
// A live run talks to the chain straight from the network card, so the VPN slows it no more and its drops do not reach it.
if (!isReplay) {
  const direct = directAddress();
  if (direct) {
    bindOutgoing(direct);
    console.error(`  трафик идёт напрямую через ${direct}, мимо VPN`);
    setInterval(() => {
      if (stillHere(direct)) return;
      console.error(`Адрес ${direct} больше не принадлежит этому компьютеру, перезапуск.`);
      process.exit(1);
    }, 60_000).unref();
  } else console.error('  прямой путь не найден, трафик идёт как обычно');
}
const publicAlways = args['public-always'];
const selfBuilt = args['self-built'] || publicAlways;
if (args['self-built'] && !isReplay) throw new Error('--self-built works only in a replay so far: live prediction is not wired in');
const blockKinds = new Map<number, BlockKind>();
const acceptedKinds: ReadonlySet<BlockKind> = new Set<BlockKind>(args['include-blank'] ? ['validator', 'blank'] : ['validator']);
const chain = CHAINS.ethereum!;
const universe = JSON.parse(await readFile(args.universe, 'utf8')) as Universe;
const universeSet = new Set(universe.pools.map((pool) => pool.address));
const inUniverse = (logs: PoolLog[]): PoolLog[] => logs.filter((log) => universeSet.has(poolKeyOf(log)));

// Answers about fixed past blocks never change, so a replay asks the network only once.
const memo = isReplay ? await Memo.open(`data/cache/memo-${chain.name}.jsonl`) : undefined;
const remember = (rpc: Rpc): Rpc => (memo ? memoizedRpc(rpc, memo) : rpc);
// A live block cannot wait: one hung connection would hold up every block after it. A replay has
// no such hurry and is better off waiting out a slow node.
const LIVE_CALL_MS = 5000;
const LIVE_HEAVY_CALL_MS = 15_000;
const rpc = isReplay ? createRpc(rpcUrlFor(chain)) : createRpc(rpcUrlFor(chain), 2, LIVE_CALL_MS);
const logsRpc = isReplay ? createRpc(process.env.LOGS_RPC_URL_ETHEREUM ?? chain.defaultLogsRpc!, 2) : createRpc(process.env.LOGS_RPC_URL_ETHEREUM ?? chain.defaultLogsRpc!, 1, LIVE_CALL_MS);
const traceRpc = isReplay ? createRpc(process.env.TRACE_RPC_URL_ETHEREUM ?? chain.defaultTraceRpc!) : createRpc(process.env.TRACE_RPC_URL_ETHEREUM ?? chain.defaultTraceRpc!, 1, LIVE_HEAVY_CALL_MS);
// A replay can afford to wait out a rate limit. A live block cannot, and fails closed instead.
const archiveRpc = remember(isReplay ? createRpc(process.env.TRACE_RPC_URL_ETHEREUM ?? rpcUrlFor(chain), 8) : createRpc(process.env.TRACE_RPC_URL_ETHEREUM ?? rpcUrlFor(chain), 2, LIVE_HEAVY_CALL_MS));
const archiveFetchRpc = createRpc(process.env.TRACE_RPC_URL_ETHEREUM ?? rpcUrlFor(chain), 8);

const config: EngineConfig = {
  policy: {
    profitHaircut: Number(args.haircut),
    minNetUsd: Number(args['min-net']),
    minExpectedValueUsd: 0,
    maxStateAgeMs: 8000,
    remainingLossBudgetUsd: selfBuilt ? Number(args['loss-budget']) : 0,
  },
  bidShare: Number(args['bid-share']),
  builders: new Set(args['all-builders'] || selfBuilt ? [] : universe.builders),
  baseGasUnits: 150_000n,
  gasUnitsPerHop: 100_000n,
  mode: selfBuilt ? 'pays-gas' : 'revert-protected',
  ...(selfBuilt
    ? {
        auction: 'tip-per-gas' as const,
        failureGasUnits: FAILED_CHECK_GAS,
        ...(publicAlways
          ? { rankedByTotal: (block: number): boolean => !acceptedKinds.has(blockKinds.get(block) ?? 'builder') }
          : { targetsBlock: (block: number): boolean => acceptedKinds.has(blockKinds.get(block) ?? 'builder') }),
        ...(args['scan-inside'] ? { scansInside: (block: number): boolean => acceptedKinds.has(blockKinds.get(block) ?? 'builder') } : {}),
      }
    : {}),
  startBalanceUsd: Number(args.balance),
  deadlineMs: 8000,
  brutalLatencyFactor: 2,
  countWorkTime: !isReplay,
  skipMidBlock: args['skip-mid-block'],
};

const starts = new Set(Object.keys(chain.tokens));
const head = Number(BigInt(await rpc.call<string>('eth_blockNumber', [])));
const replayTo = args.to ? Number(args.to) : lastCompleteBlock(head, SETTLED_BLOCKS);
const replayFrom = args.from ? Number(args.from) : replayTo - Number(args.blocks) + 1;
const startBlock = isReplay ? replayFrom - 1 : head;
const view = args['no-evm'] ? undefined : await createChainView(archiveRpc, universe.pools, chain.wrappedNative, `0x${startBlock.toString(16)}`, memo, args.universe === 'data/universe-ethereum.json' ? 'fees' : `fees-${basename(args.universe)}`, isReplay ? archiveFetchRpc : archiveRpc);
if (view) console.error(`Проверка в EVM включена. Пулов с плавающей комиссией: ${view.dynamicPools}`);
const engine = new PaperEngine(universe.pools, starts, new Set(universe.tokens), config, createRivalLookup(rpc, traceRpc, memo), view, createTipLookup(isReplay ? archiveFetchRpc : traceRpc, memo));

const decimals = new Map<string, number>();
await Promise.all([...starts].map(async (token) => decimals.set(token, Number(BigInt(await rpc.call<string>('eth_call', [{ to: token, data: DECIMALS }, 'latest']))))));

const majorPricesAt = await createPriceReader(remember, isReplay ? {} : { retries: 3, timeoutMs: LIVE_CALL_MS });
const toPrices = (major: MajorPrices): Prices => {
  const usd: Prices['usd'] = new Map();
  for (const [token, asset] of Object.entries(chain.tokens)) {
    const price = asset === 'USD' ? 1 : asset === 'ETH' ? major.ETH : major.BTC;
    usd.set(token, { price, decimals: decimals.get(token)! });
  }
  return { usd, nativeUsd: major.ETH };
};

const parseHeader = (raw: Record<string, string>): BlockHeader => ({
  number: Number(BigInt(raw.number!)),
  hash: raw.hash!,
  timestamp: Number(BigInt(raw.timestamp!)),
  baseFeeWei: BigInt(raw.baseFeePerGas!),
  gasUsed: BigInt(raw.gasUsed!),
  gasLimit: BigInt(raw.gasLimit!),
  miner: raw.miner!,
  ...(raw.extraData ? { extraData: raw.extraData } : {}),
});
const fetchHeader = async (number: number): Promise<BlockHeader> =>
  parseHeader(await rpc.call<Record<string, string>>('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]));

const startedAt = new Date().toISOString();
const stem = `data/paper-${args.mode}-${startedAt.replaceAll(':', '-')}${args.label ? `-${args.label}` : ''}`;
const latencies: number[] = [];
const CAUGHT_UP_MS = 15_000;
let caughtUp = false;
// Plans every attempt and applies the real limits, but holds no key and sends nothing.
const sender = args['dry-send'] ? new DryRunSender(new RiskGuard(DEFAULT_LIMITS, newRiskState(Date.now())), `${stem}-sender.jsonl`) : null;

// Who stands behind the coming slots. Read in the background, so it can never hold up a block.
const slotOdds = args['live-send'] ? loadSlotOdds('data') : null;
const refreshRelays = async (): Promise<void> => {
  const lists = await Promise.all(RELAYS.map((relay) => fetchRelayList(relay)));
  slotOdds?.noteRelays(lists.filter((list) => list !== null));
};
if (slotOdds) {
  console.error(`  шансы слотов: в истории ${slotOdds.history.blocks} блоков, самосборных ${slotOdds.history.own}`);
  await refreshRelays();
  console.error(`  реле ответили: ${slotOdds.relaysAnswering} из ${RELAYS.length}`);
  setInterval(() => void refreshRelays().catch(() => {}), (SLOTS_PER_EPOCH * 12 * 1000) / 2).unref();
}

/** Real money. It takes a deployed contract, a key and a written confirmation to get past here. */
async function createLiveSender(): Promise<LiveSender | null> {
  if (!args['live-send']) return null;
  if (isReplay || !publicAlways) throw new Error('--live-send needs --mode live and --public-always');
  if (process.env.SENDER_CONFIRM !== REQUIRED_CONFIRMATION) throw new Error(`Set SENDER_CONFIRM=${REQUIRED_CONFIRMATION} to send with real money`);
  const key = process.env.SENDER_PRIVATE_KEY as `0x${string}` | undefined;
  const executor = process.env.EXECUTOR_ADDRESS as `0x${string}` | undefined;
  const treasury = process.env.TREASURY_ADDRESS;
  if (!key || !executor || !treasury) throw new Error('SENDER_PRIVATE_KEY, EXECUTOR_ADDRESS and TREASURY_ADDRESS must all be set');
  const stateFile = 'data/sender-state.json';
  // Limits already reached stay reached, whatever happened to the program in between.
  const saved = await readFile(stateFile, 'utf8').then((text) => JSON.parse(text) as RiskState, () => newRiskState(Date.now()));
  const experiment = args['every-block'] ? loadOrStartExperiment('data/experiment.json', saved.totalNetUsd, Number(args['experiment-loss']), new Date()) : null;
  const minOwnChance = args['min-own-chance'] === undefined ? null : Number(args['min-own-chance']);
  if (minOwnChance !== null && !(minOwnChance >= 0 && minOwnChance <= 1)) throw new Error('--min-own-chance is a share from 0 to 1');
  if (experiment) console.error(`  ЭКСПЕРИМЕНТ «каждый блок» с ${experiment.startedAt}: остановка при потере $${experiment.lossBudgetUsd} от итога ${experiment.startNetUsd.toFixed(2)}`);
  if (experiment && minOwnChance !== null) console.error(`  открыто — только в слотах с шансом самосборного блока от ${(minOwnChance * 100).toFixed(0)}%, в остальных пакеты`);
  const account = privateKeyToAccount(key);
  // Off the path of sending, so it can afford to wait longer than a live call.
  const bundleCheckRpc = createRpc(rpcUrlFor(chain), 1, LIVE_HEAVY_CALL_MS);
  /** Long enough for the target block to pass and for Eureka to file its record of the bundle. */
  const TRACE_AFTER_MS = 60_000;
  const TRACE_RETRY_MS = 30_000;
  if (!(await deployedMatchesBuild(rpc, executor, account.address, treasury))) throw new Error(`The contract at ${executor} is not this build. Deploy the current one with src/sender/deploy.ts`);
  return new LiveSender({
    // No retries: asking for the receipt of a transaction not yet mined answers "nothing", and a
    // retrying client waited 16 s on that at every block, leaving the engine behind the chain.
    rpc: createRpc(rpcUrlFor(chain), 0, LIVE_CALL_MS),
    broadcast: PUBLIC_NODES.map(({ name, url }) => ({ name, rpc: createRpc(url, 0, LIVE_CALL_MS) })),
    account,
    executor,
    treasury: treasury.toLowerCase(),
    chainId: 1,
    metas: new Map(universe.pools.map((pool) => [pool.address, pool])),
    wrappedNative: chain.wrappedNative,
    guard: new RiskGuard(experiment ? experimentLimits(DEFAULT_LIMITS, experiment) : DEFAULT_LIMITS, saved),
    stateFile,
    logFile: `${stem}-live-sender.jsonl`,
    stopFile: 'data/STOP',
    reserveWei: LIVE_SENDER_RESERVE_WEI,
    needTipWei: (trade, neededUsd) => foresight?.needTipWei(trade, neededUsd) ?? 0n,
    sendBundle: (txs, targetBlock) => sendBundle(BUILDER_ENDPOINTS, txs, targetBlock, account),
    checkBundle: (txs, targetBlock) => checkAtTopOfBlock(bundleCheckRpc, txs, targetBlock),
    // Eureka simulates every bundle it gets and tells what became of it, so it is asked once the block is over.
    traceBundle: async (answers) => {
      const bundleHash = (answers as BundleAnswer[]).find((answer) => answer.name === 'eureka')?.bundleHash;
      if (!bundleHash) return null;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      await wait(TRACE_AFTER_MS);
      // Its record shows up 30-45 s after sending, so a "not found" gets one more try.
      const trace = await traceAtEureka(bundleHash).catch(async (err: Error) => {
        if (!/not found/.test(err.message)) throw err;
        await wait(TRACE_RETRY_MS);
        return traceAtEureka(bundleHash);
      });
      return { builder: 'eureka', bundleHash, ...trace };
    },
    resultsFile: 'data/results.csv',
    blockKindOf: (block) => blockKinds.get(block) ?? null,
    // The experiment allows for no failure in advance. Its first day found all 70 public attempts in builder
    // blocks lost, so with a minimum chance the public ones go only where a self-built block is that likely.
    ...(experiment
      ? { failuresPerWin: () => 0, ...(minOwnChance !== null && slotOdds ? { slotTakesPublic: (timestamp: number) => (slotOdds.chanceAt(slotOf(timestamp)) ?? 0) >= minOwnChance } : {}) }
      : slotOdds
        ? { failuresPerWin: (timestamp: number) => slotOdds.failuresPerWinAt(slotOf(timestamp)), slotTakesPublic: (timestamp: number) => slotOdds.isNearlySure(slotOf(timestamp)) }
        : {}),
  });
}
const liveSender = await createLiveSender();
const gasWatch = new GasWatch();
if (args.foresee && isReplay) throw new Error('--foresee works only in a live run');
const tipLookup = createTipLookup(traceRpc, memo);
const foresight = args.foresee
  ? new Foresight({
      rpc: createRpc(rpcUrlFor(chain), 0, LIVE_CALL_MS),
      book: engine.book,
      metas: new Map(universe.pools.map((pool) => [pool.address, pool])),
      wrappedNative: chain.wrappedNative,
      foresee: (logs, nextFeeWei, current) => engine.foresee(logs, nextFeeWei, current),
      tipOf: (block, hash) => tipLookup(block, [hash]),
      logFile: `${stem}-foresight.jsonl`,
      minNetUsd: config.policy.minNetUsd,
      ...(args['every-block'] ? { failuresPerWin: () => 0 } : slotOdds ? { failuresPerWin: (timestamp: number) => slotOdds.failuresPerWinAt(slotOf(timestamp)) } : {}),
      onPrivateBackrun: (trade, opener, state) => {
        // A self-built block sees only the public mempool, so there the public place is the one that counts.
        if (slotOdds?.isNearlySure(slotOf(state.timestamp + 12))) return;
        void liveSender?.proposeBackrunBundle([trade], { nextBaseFeeWei: state.nextFeeWei, nativeUsd: state.prices.nativeUsd, timestamp: state.timestamp, minNetUsd: config.policy.minNetUsd, failureGasUnits: FAILED_CHECK_GAS }, opener).catch((err: Error) => console.error(`  пакет не отправлен: ${err.message}`));
      },
      onBackrun: (trade, tipWei, state) => {
        void liveSender?.propose([trade], { nextBaseFeeWei: state.nextFeeWei, nativeUsd: state.prices.nativeUsd, timestamp: state.timestamp, minNetUsd: config.policy.minNetUsd, failureGasUnits: FAILED_CHECK_GAS }, { tipWei }).catch((err: Error) => console.error(`  бэкран не отправлен: ${err.message}`));
      },
    })
  : null;
let fromBlock = 0;
let lastBlock = 0;
let visibility: VisibilityStats | undefined;
let recall: RecallStats | undefined;

const modelSummary = (errors: number[]) => ({ checks: errors.length, medianError: quantile(errors, 0.5), p99Error: quantile(errors, 0.99) });

const summarize = (): PaperSummary => ({
  mode: args.mode as PaperSummary['mode'],
  startedAt,
  updatedAt: new Date().toISOString(),
  fromBlock,
  lastBlock,
  blockTime: BLOCK_TIME,
  universe: {
    pools: universe.pools.length,
    v2: universe.pools.filter((pool) => pool.kind === 'v2').length,
    v3: universe.pools.filter((pool) => pool.kind === 'v3').length,
    v4: universe.pools.filter((pool) => pool.kind === 'v4').length,
    routes: engine.cycles.length,
    splitBlock: universe.splitBlock,
  },
  assumptions: {
    bidShare: config.bidShare,
    profitHaircut: config.policy.profitHaircut,
    minNetUsd: config.policy.minNetUsd,
    infraUsdPerDay: Number(args.infra),
    startBalanceUsd: config.startBalanceUsd,
  },
  stats: engine.stats,
  model: {
    v2: modelSummary(engine.book.modelErrors.v2),
    v3: modelSummary(engine.book.modelErrors.v3),
    v4: modelSummary(engine.book.modelErrors.v4),
    crossing: modelSummary(engine.book.modelErrors.crossing),
  },
  depthPools: engine.book.depthCount(),
  latencyMs: { median: quantile(latencies, 0.5), p99: quantile(latencies, 0.99) },
  verifiedPools: universe.pools.filter((pool) => engine.book.isVerified(pool.address)).length,
  ...(visibility ? { visibility } : {}),
  ...(recall ? { recall } : {}),
});

const save = async (): Promise<void> => {
  await writeFile(`${stem}.json`, JSON.stringify(summarize(), null, 2));
};

await mkdir('data', { recursive: true });

const processBlock = async (header: BlockHeader, logs: PoolLog[], prices: Prices, latencyMs: number, tracker?: PendingTracker): Promise<string[][]> => {
  // A live header says who built the block. A replay read this from the chain beforehand.
  if (header.extraData) blockKinds.set(header.number, blockKind(header.extraData));
  const settled = await engine.onBlock(header, logs, prices, latencyMs);
  if (foresight) {
    // Comparing with the block takes node calls, which must never hold up the block itself.
    void foresight.onBlock(header, logs, blockKinds.get(header.number) ?? 'builder', nextBaseFee(header.baseFeeWei, header.gasUsed, header.gasLimit), prices).catch(() => {});
    foresight.noteTrades(engine.lastSent);
  }
  if (sender) {
    const now = header.timestamp * 1000;
    for (const trade of settled) await sender.settle(trade, now);
    const nextBaseFeeWei = nextBaseFee(header.baseFeeWei, header.gasUsed, header.gasLimit);
    for (const trade of engine.lastSent) {
      await sender.propose(trade, { nextBaseFeeWei, nativeUsd: prices.nativeUsd, timestamp: header.timestamp, minNetUsd: config.policy.minNetUsd, failureGasUnits: FAILED_CHECK_GAS }, now);
    }
  }
  if (liveSender) {
    const gasNews = gasWatch.note(Number(header.baseFeeWei) / 1e9);
    if (gasNews) console.error(`  ${gasNews}`);
    await liveSender.onBlock(header.number);
    const slotRecord = slotOdds?.noteBlock(header.number, slotOf(header.timestamp), blockKinds.get(header.number) ?? 'builder');
    if (slotRecord) void appendFile(`${stem.replace('paper-live-', 'proposers-')}.jsonl`, `${slotRecord}\n`).catch(() => {});
    await liveSender.propose(engine.lastSent, {
      nextBaseFeeWei: nextBaseFee(header.baseFeeWei, header.gasUsed, header.gasLimit),
      nativeUsd: prices.nativeUsd,
      timestamp: header.timestamp,
      minNetUsd: config.policy.minNetUsd,
      failureGasUnits: FAILED_CHECK_GAS,
    });
  }
  lastBlock = header.number;
  if (settled.length > 0) await appendFile(`${stem}-trades.jsonl`, settled.map((trade) => JSON.stringify(trade)).join('\n') + '\n');

  const blockMs = header.timestamp * 1000;
  const covered = tracker?.isCovered(blockMs, Date.now()) ?? false;
  if (tracker && visibility) {
    if (covered) visibility.blocksCovered++;
    else visibility.blocksExcluded++;
  }
  const logged: string[] = [];
  for (const gap of engine.lastGaps) {
    let parts: { txHash: string; usd: number; visibility: Visibility }[] = [];
    if (tracker && visibility && covered) {
      parts = gap.contributions.map(({ txHash, usd }) => {
        const swapLogs = logs.filter((log) => log.transactionHash === txHash && SWAP_TOPICS.has(log.topics[0] ?? ''));
        return { txHash, usd, visibility: tracker.classify(txHash, swapLogs, blockMs) };
      });
      addGap(visibility, gap.usd, parts);
    }
    if (gap.usd >= MIN_LOGGED_GAP_USD) logged.push(JSON.stringify({ block: header.number, builder: header.miner, parts, ...gap }));
  }
  if (logged.length > 0) await appendFile(`${stem}-gaps.jsonl`, logged.join('\n') + '\n');

  for (const trade of settled) {
    const results = `мягкий ${trade.results.optimistic.outcome}, реальный ${trade.results.realistic.outcome}, лютый ${trade.results.brutal.outcome}`;
    console.error(`  блок ${trade.targetBlock}: прибыль $${trade.profitUsd.toFixed(2)}, выплата $${trade.bidUsd.toFixed(2)}, газ $${trade.gasUsd.toFixed(2)} -> ${results}`);
  }
  return [...engine.lastGaps.map((gap) => gap.pools), ...settled.map((trade) => trade.pools)];
};

const verifiedCount = (): number => universe.pools.filter((pool) => engine.book.isVerified(pool.address)).length;

const readDepth = async (block: number): Promise<void> => {
  if (args['one-tick']) return;
  const { loaded, skipped } = await loadDepths(isReplay ? archiveRpc : archiveFetchRpc, universe.pools, engine.book, `0x${block.toString(16)}`);
  engine.book.trackDepthChanges = true;
  console.error(`Глубина пулов на блок ${block}: загружено ${loaded}, пропущено ${skipped}`);
};

const finishWarmup = async (block: number): Promise<void> => {
  engine.book.modelErrors.v2.length = 0;
  engine.book.modelErrors.v3.length = 0;
  engine.book.modelErrors.v4.length = 0;
  engine.book.modelErrors.crossing.length = 0;
  console.error(`Прогрев готов: подтверждено пулов ${verifiedCount()} из ${universe.pools.length}, маршрутов ${engine.cycles.length}`);
  await readDepth(block);
};

async function warmUp(toBlock: number): Promise<void> {
  const from = toBlock - Number(args.warmup) + 1;
  for (let start = from; start <= toBlock; start += 100) {
    engine.warm(inUniverse(await fetchRangeLogs(logsRpc, STATE_TOPICS, start, Math.min(start + 99, toBlock))));
  }
  await finishWarmup(toBlock);
}

/** Real wins recorded earlier, used to check whether the search finds what bots actually took. */
async function loadWins(from: number, to: number): Promise<Map<number, { pools: string[]; retainedUsd: number }[]>> {
  const wins = new Map<number, { pools: string[]; retainedUsd: number }[]>();
  const files = await readdir('data');
  const reconFile = files.filter((f) => f.startsWith('recon-ethereum-')).sort().at(-1);
  const paymentsFile = files.filter((f) => f.startsWith('payments-ethereum-')).sort().at(-1);
  if (!reconFile || !paymentsFile) return wins;
  const recon = JSON.parse(await readFile(`data/${reconFile}`, 'utf8')) as { hits: { kind: string; block: number; hash: string; pools: string[] }[] };
  const payments = JSON.parse(await readFile(`data/${paymentsFile}`, 'utf8')) as { hits: { hash: string; retainedUsd: number; failed: boolean; excluded: boolean }[] };
  const retained = new Map(payments.hits.filter((hit) => !hit.failed && !hit.excluded).map((hit) => [hit.hash, hit.retainedUsd]));
  for (const hit of recon.hits) {
    if (hit.kind !== 'arb' || hit.block < from || hit.block > to || !retained.has(hit.hash)) continue;
    wins.set(hit.block, [...(wins.get(hit.block) ?? []), { pools: hit.pools, retainedUsd: Math.max(retained.get(hit.hash)!, 0) }]);
  }
  return wins;
}

/** Everything a replay needs, fetched with an address filter so nodes return only our pools. */
const fetchChunk = async (from: number, to: number): Promise<Chunk> => {
  const addresses = [...new Set(universe.pools.map((pool) => (pool.kind === 'v4' ? V4_POOL_MANAGER : pool.address)))];
  const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const [logs, headers] = await Promise.all([
    fetchRangeLogs(archiveFetchRpc, STATE_TOPICS, from, to, addresses),
    mapLimit(numbers, HEADER_CONCURRENCY, (number) => archiveFetchRpc.call<Record<string, string>>('eth_getBlockByNumber', [`0x${number.toString(16)}`, false])),
  ]);
  const fields = ['number', 'hash', 'timestamp', 'baseFeePerGas', 'gasUsed', 'gasLimit', 'miner'] as const;
  return {
    headers: headers.map((raw) => Object.fromEntries(fields.map((field) => [field, raw[field]!]))),
    logs: inUniverse(logs).map(({ address, topics, data, transactionHash, logIndex, blockNumber }) => ({ address, topics, data, transactionHash, logIndex, ...(blockNumber ? { blockNumber } : {}) })),
  };
};

async function replay(): Promise<void> {
  fromBlock = replayFrom;
  if (fromBlock <= universe.splitBlock) {
    throw new Error(`Block ${fromBlock} overlaps the data used to pick pools (up to ${universe.splitBlock}). Use fewer --blocks.`);
  }
  const warmFrom = fromBlock - Number(args.warmup);
  const archive = new Archive(archiveDir('data/archive', chain.name, [...universeSet]), fetchChunk);
  console.error(`Реплей ${fromBlock}..${replayTo}, прогрев ${args.warmup} блоков`);
  await archive.ensure(warmFrom, replayTo, Number(args.concurrency), (done, total) => {
    if (done % 25 === 0 || done === total) console.error(`  архив: ${done}/${total} кусков`);
  });
  if (view) {
    await view.prefetchFees(fromBlock, replayTo, Number(args.concurrency));
    console.error(`  комиссии прочитаны, сбоев чтения: ${view.failedRefreshes()}`);
  }
  if (selfBuilt) {
    // What each block turned out to be stands in for a prediction here. Its real accuracy is
    // measured separately on live blocks, and the result has to be scaled by it.
    const numbers = Array.from({ length: replayTo - fromBlock + 1 }, (_, i) => fromBlock + i);
    await mapLimit(numbers, Number(args.concurrency), async (number) => {
      const kind = await memo!.get(`kind:${number}`, async () => blockKind((await archiveFetchRpc.call<{ extraData: string }>('eth_getBlockByNumber', [`0x${number.toString(16)}`, false])).extraData));
      blockKinds.set(number, kind);
    });
    console.error(`  типы блоков прочитаны: самосборных ${[...blockKinds.values()].filter((kind) => acceptedKinds.has(kind)).length} из ${blockKinds.size}`);
  }

  for await (const { logs } of archive.blocks(warmFrom, fromBlock - 1)) engine.warm(logs);
  await finishWarmup(fromBlock - 1);

  const wins = await loadWins(fromBlock, replayTo);
  recall = newRecallStats();

  let prices: Prices | null = null;
  for await (const { header: raw, logs } of archive.blocks(fromBlock, replayTo)) {
    const header = parseHeader(raw);
    const elapsed = header.number - fromBlock;
    if (prices === null || elapsed % PRICE_REFRESH_BLOCKS === 0) prices = toPrices(await majorPricesAt(header.timestamp));
    const routes = await processBlock(header, logs, prices, 0);
    for (const win of wins.get(header.number) ?? []) addWin(recall, winWasFound(win.pools, routes), win.retainedUsd);
    if (elapsed > 0 && elapsed % DEPTH_REFRESH_BLOCKS === 0) await readDepth(header.number);
    if (elapsed % 1000 === 0) {
      console.error(`  ${elapsed + 1}/${replayTo - fromBlock + 1} блоков, отправлено ${engine.stats.sent}, в памяти ${memo?.size ?? 0}`);
      await save();
    }
  }
  await save();
}

async function live(): Promise<void> {
  let next = Number(BigInt(await rpc.call<string>('eth_blockNumber', []))) + 1;
  fromBlock = next;
  console.error(`Живой режим с блока ${next}, прогрев ${args.warmup} блоков. Остановка: Ctrl+C`);
  await warmUp(next - 1);

  const tracker = new PendingTracker();
  visibility = newVisibilityStats();
  const pushed = new Map<number, BlockHeader>();
  let newestPushed = 0;
  let wake: (() => void) | null = null;
  const stopStreams = connectStreams(tracker, {
    say: (message) => console.error(`  ${message}`),
    fullTransactions: foresight !== null,
    onTransaction: (_hash, _now, tx) => {
      if (tx) foresight?.onPending(tx as unknown as PendingCall);
    },
    onHead: (raw) => {
      const header = parseHeader(raw);
      pushed.set(header.number, header);
      newestPushed = Math.max(newestPushed, header.number);
      wake?.();
    },
  });

  const deadline = args['max-minutes'] ? Date.now() + Number(args['max-minutes']) * 60_000 : Number.POSITIVE_INFINITY;
  const pollMs = Number(args['poll-ms']);
  let prices: Prices | null = null;
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
    wake?.();
  });

  while (!stop && Date.now() < deadline) {
    try {
      if (newestPushed < next) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, pollMs);
        });
        wake = null;
      }
      // The push is the fast path. Polling covers a dropped socket and any blocks it missed.
      const head = newestPushed >= next ? newestPushed : Number(BigInt(await rpc.call<string>('eth_blockNumber', [])));
      for (; next <= head && !stop; next++) {
        // Fetched first and processed once, so a network failure can retry without double-counting.
        const header = pushed.get(next) ?? (await fetchHeader(next));
        // One node's trouble should not cost a block while another can answer.
        const logs = inUniverse(await fetchBlockLogs(logsRpc, STATE_TOPICS, header.hash!).catch(() => fetchBlockLogs(rpc, STATE_TOPICS, header.hash!)));
        if (prices === null) prices = toPrices(await majorPricesAt(header.timestamp - 4));
        // A price a few minutes old does no harm. A block held up waiting for a slow node does.
        else if (next % 25 === 0) {
          void majorPricesAt(header.timestamp - 4).then(
            (major) => {
              prices = toPrices(major);
            },
            (err: Error) => console.error(`  цены не обновлены: ${err.message}`),
          );
        }
        const latencyMs = Date.now() - header.timestamp * 1000;
        // Blocks read while catching up after the warm-up say nothing about how fast we run.
        caughtUp ||= latencyMs < CAUGHT_UP_MS;
        if (caughtUp) latencies.push(latencyMs);
        await processBlock(header, logs, prices, latencyMs, tracker);
        pushed.delete(next);
        // Done in the background so that it never holds up a block. An unlucky failure only
        // means the older reading stays in use until the next attempt.
        if (next % DEPTH_REFRESH_BLOCKS === 0) void readDepth(next).catch((err: Error) => console.error(`  глубина не обновлена: ${err.message}`));
        if (engine.stats.blocks % SAVE_EVERY_BLOCKS === 0) {
          tracker.prune(Date.now());
          await save();
          const v = visibility.buckets[0]!;
          console.error(`  блок ${next}: задержка ${latencyMs} мс, отправлено ${engine.stats.sent}, разрывов внутри блока ${v.count}, из них видно в мемпуле ${v.byClass.mempool.count}, лютый баланс $${engine.stats.scenarios.brutal.balanceUsd.toFixed(2)}`);
          if (foresight) console.error(`  просчёт мемпула: ${JSON.stringify(foresight.stats)}`);
        }
      }
    } catch (err) {
      console.error(`  сбой сети, повтор через ${RPC_FAILURE_WAIT_MS / 1000} с: ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, RPC_FAILURE_WAIT_MS));
    }
  }
  stopStreams();
  await save();
}

if (args.mode === 'replay') await replay();
else if (args.mode === 'live') await live();
else throw new Error(`Unknown mode ${args.mode}. Use replay or live.`);

console.log(formatReport(summarize()));
if (sender) {
  const s = sender.summary;
  const days = (engine.stats.blocks * BLOCK_TIME) / 86_400;
  console.log(`\nСухая отправка: запланировано ${s.planned}, побед ${s.won}, неудач ${s.failed}, не вошло в блок ${s.notIncluded}, лимиты отказали ${JSON.stringify(s.refused)}, без плана ${s.noPlan}`);
  console.log(`Итог с лимитами ${s.netUsd.toFixed(2)} USD, ${days > 0 ? (s.netUsd / days).toFixed(2) : '-'} в день, из них неудачи ${s.failureCostUsd.toFixed(2)} USD`);
}
if (liveSender) console.log(`\nНАСТОЯЩАЯ отправка: ${JSON.stringify(liveSender.summary)}`);
console.log(`\nСохранено: ${stem}.json`);
