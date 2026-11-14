import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CHAINS, ETHEREUM_VETTED_TOKENS, rpcUrlFor } from '../chains.ts';
import { createRpc, mapLimit } from '../rpc.ts';
import { fetchRangeLogs } from './feed.ts';
import { PANCAKE_V3_SWAP, poolKeyOf, V2_SWAP, V3_SWAP, V4_INITIALIZE, V4_POOL_MANAGER, V4_SWAP, type PoolLog, type PoolMeta } from './pools.ts';
import { outputTransferMatches, parseInitialize, tokenPasses, v4Meta, v4PoolId } from './vetting.ts';

/**
 * Picks the pools the emulator watches, by real trading activity, using only blocks older
 * than a cut-off. The test then runs on later blocks, so it cannot benefit from knowing
 * where profit appeared.
 */

export interface Universe {
  chain: string;
  splitBlock: number;
  builtFrom: string;
  pools: PoolMeta[];
  builders: string[];
  /** Tokens routes may pass through. */
  tokens: string[];
}

const SELECTOR = { token0: '0x0dfe1681', token1: '0xd21220a7', fee: '0xddca3f43', tickSpacing: '0xd0c93a7c', getReserves: '0x0902f1ac' };
const V4_DEPLOY_BLOCK = 21_688_329;
const LOG_CHUNK = 100;
const RECEIPTS_PER_TOKEN = 3;

const { values: args } = parseArgs({
  options: {
    holdout: { type: 'string', default: '3' },
    'discovery-blocks': { type: 'string', default: '2400' },
    'min-swaps': { type: 'string', default: '15' },
    'max-pools': { type: 'string', default: '600' },
    builders: { type: 'string', default: '3' },
    out: { type: 'string', default: 'data/universe-ethereum.json' },
  },
});

const chain = CHAINS.ethereum!;
const rpc = createRpc(rpcUrlFor(chain));
const logsRpc = createRpc(process.env.LOGS_RPC_URL_ETHEREUM ?? chain.defaultLogsRpc!, 2);
const patientLogsRpc = createRpc(process.env.LOGS_RPC_URL_ETHEREUM ?? chain.defaultLogsRpc!, 7);

const files = await readdir('data');
const reconFile = files.filter((f) => f.startsWith('recon-ethereum-')).sort().at(-1);
const paymentsFile = files.filter((f) => f.startsWith('payments-ethereum-')).sort().at(-1);
if (!reconFile || !paymentsFile) throw new Error('Run recon and payments for ethereum first');

interface ReconHit {
  kind: string;
  block: number;
  hash: string;
  pools: string[];
}
const recon = JSON.parse(await readFile(`data/${reconFile}`, 'utf8')) as { head: number; blockTime: number; hits: ReconHit[] };
const payments = JSON.parse(await readFile(`data/${paymentsFile}`, 'utf8')) as { hits: { hash: string; miner: string }[] };

const splitBlock = recon.head - Math.floor((Number(args.holdout) * 86_400) / recon.blockTime);
const training = recon.hits.filter((h) => h.kind === 'arb' && h.block < splitBlock);

const trainingHashes = new Set(training.map((h) => h.hash));
const minerCounts = new Map<string, number>();
for (const hit of payments.hits) {
  if (hit.miner && trainingHashes.has(hit.hash)) minerCounts.set(hit.miner.toLowerCase(), (minerCounts.get(hit.miner.toLowerCase()) ?? 0) + 1);
}
const totalMined = [...minerCounts.values()].reduce((a, b) => a + b, 0);
const topBuilders = [...minerCounts].sort((a, b) => b[1] - a[1]).slice(0, Number(args.builders));

const discoveryBlocks = Number(args['discovery-blocks']);
const discoveryStart = splitBlock - discoveryBlocks;
console.error(`Discovery: blocks ${discoveryStart}..${splitBlock - 1}`);

const swapCounts = new Map<string, number>();
const sampleSwaps = new Map<string, PoolLog[]>();
const SWAPS = [V2_SWAP, V3_SWAP, PANCAKE_V3_SWAP, V4_SWAP];
const starts = Array.from({ length: Math.ceil(discoveryBlocks / LOG_CHUNK) }, (_, i) => discoveryStart + i * LOG_CHUNK);
let doneChunks = 0;
await mapLimit(starts, 4, async (start) => {
  const logs = await fetchRangeLogs(logsRpc, SWAPS, start, Math.min(start + LOG_CHUNK - 1, splitBlock - 1));
  for (const log of logs) {
    const key = poolKeyOf(log);
    swapCounts.set(key, (swapCounts.get(key) ?? 0) + 1);
    const samples = sampleSwaps.get(key) ?? [];
    if (samples.length < 12) samples.push(log);
    sampleSwaps.set(key, samples);
  }
  if (++doneChunks % 5 === 0) console.error(`  ${doneChunks}/${starts.length} chunks, ${swapCounts.size} pools so far`);
});

const minSwaps = Number(args['min-swaps']);
const candidates = [...swapCounts].filter(([, n]) => n >= minSwaps).sort((a, b) => b[1] - a[1]).slice(0, Number(args['max-pools'])).map(([key]) => key);
console.error(`${swapCounts.size} active pools, ${candidates.length} with at least ${minSwaps} swaps`);

const read = async (to: string, data: string): Promise<string | null> => {
  try {
    const result = await rpc.call<string>('eth_call', [{ to, data }, 'latest']);
    return result === '0x' ? null : result;
  } catch {
    return null;
  }
};
const toAddress = (word: string): string => `0x${word.slice(-40)}`.toLowerCase();

let hookedV4 = 0;
let failedV4 = 0;
const describeV4 = async (id: string): Promise<PoolMeta | null> => {
  try {
    const logs = await patientLogsRpc.call<PoolLog[]>('eth_getLogs', [
      { address: V4_POOL_MANAGER, topics: [V4_INITIALIZE, id], fromBlock: `0x${V4_DEPLOY_BLOCK.toString(16)}`, toBlock: `0x${splitBlock.toString(16)}` },
    ]);
    if (!logs[0]) throw new Error('no Initialize');
    const key = parseInitialize(logs[0]);
    if (v4PoolId(key) !== id) throw new Error('pool id does not match its key');
    const meta = v4Meta(id, key, chain.wrappedNative);
    if (!meta) hookedV4++;
    return meta;
  } catch {
    failedV4++;
    return null;
  }
};

const describeContract = async (address: string): Promise<PoolMeta | null> => {
  const [token0, token1] = await Promise.all([read(address, SELECTOR.token0), read(address, SELECTOR.token1)]);
  if (!token0 || !token1) return null;
  const [fee, tickSpacing, reserves] = await Promise.all([read(address, SELECTOR.fee), read(address, SELECTOR.tickSpacing), read(address, SELECTOR.getReserves)]);
  const base = { address, token0: toAddress(token0), token1: toAddress(token1) };
  if (fee && tickSpacing) return { ...base, kind: 'v3', fee: Number(BigInt(fee)), tickSpacing: Number(BigInt.asIntN(256, BigInt(tickSpacing))) };
  if (reserves) return { ...base, kind: 'v2', fee: 0, tickSpacing: 0 };
  return null;
};

const isV4Id = (key: string): boolean => key.length === 66;
const contracts = candidates.filter((key) => !isV4Id(key));
const v4Ids = candidates.filter(isV4Id);
const describedContracts = await mapLimit(contracts, 6, describeContract);
console.error(`Described ${contracts.length} pools. Looking up ${v4Ids.length} V4 pools.`);
const describedV4 = await mapLimit(v4Ids, 2, describeV4);
const all = [...describedContracts, ...describedV4].filter((p): p is PoolMeta => p !== null);

/**
 * Tax tokens make a pool's logs overstate what a trader receives. Every token outside the
 * static list must show untaxed transfers in real swaps before routes may use it.
 */
const staticTokens = new Set(Object.values(ETHEREUM_VETTED_TOKENS));
const needVetting = new Set<string>();
for (const pool of all) for (const token of [pool.token0, pool.token1]) if (!staticTokens.has(token)) needVetting.add(token);

const word = (data: string, index: number): bigint => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);

/** The amount a real swap paid out of the pool in this token, or null if it paid the other side. */
function outputOf(log: PoolLog, pool: PoolMeta, token: string): bigint | null {
  if (log.topics[0] === V2_SWAP) {
    const out = token === pool.token0 ? word(log.data, 2) : word(log.data, 3);
    return out > 0n ? out : null;
  }
  const amount = BigInt.asIntN(256, word(log.data, token === pool.token0 ? 0 : 1));
  return amount < 0n ? -amount : null;
}

const contractPools = all.filter((p) => p.kind !== 'v4');
const vettedAuto = new Set<string>();
const rejected: string[] = [];
const unprovable: string[] = [];
await mapLimit([...needVetting], 4, async (token) => {
  const samples: { pool: PoolMeta; log: PoolLog; amount: bigint }[] = [];
  for (const pool of contractPools) {
    if (pool.token0 !== token && pool.token1 !== token) continue;
    for (const log of sampleSwaps.get(pool.address) ?? []) {
      const amount = outputOf(log, pool, token);
      if (amount !== null && samples.length < RECEIPTS_PER_TOKEN) samples.push({ pool, log, amount });
    }
  }
  const results: boolean[] = [];
  for (const { pool, log, amount } of samples) {
    try {
      const receipt = await rpc.call<{ logs: PoolLog[] }>('eth_getTransactionReceipt', [log.transactionHash]);
      results.push(outputTransferMatches(receipt.logs, token, pool.address, amount));
    } catch {
      // A failed lookup is missing evidence, which keeps the token out.
    }
  }
  if (tokenPasses(results)) vettedAuto.add(token);
  else if (results.includes(false)) rejected.push(token);
  else unprovable.push(token);
});

const tokens = new Set([...staticTokens, ...vettedAuto]);
const pools = all.filter((p) => tokens.has(p.token0) && tokens.has(p.token1));

const universe: Universe = {
  chain: chain.name,
  splitBlock,
  builtFrom: `${discoveryBlocks} blocks before the split`,
  pools,
  builders: topBuilders.map(([miner]) => miner),
  tokens: [...tokens],
};
await mkdir('data', { recursive: true });
await writeFile(args.out, JSON.stringify(universe, null, 2));

const kindCount = (kind: PoolMeta['kind']): number => pools.filter((p) => p.kind === kind).length;
console.log(`Split ${splitBlock}. Holdout starts after it.`);
console.log(`Candidates ${candidates.length}: described ${all.length}, V4 with hooks skipped ${hookedV4}, V4 lookups failed ${failedV4}`);
console.log(`Tokens: static ${staticTokens.size}, auto-vetted ${vettedAuto.size}, rejected for transfer mismatch ${rejected.length}, no evidence ${unprovable.length}`);
console.log(`Pools in universe: ${pools.length} (V2 ${kindCount('v2')}, V3 ${kindCount('v3')}, V4 ${kindCount('v4')})`);
console.log(`Builders: ${topBuilders.map(([m, n]) => `${m.slice(0, 10)} ${((n / totalMined) * 100).toFixed(0)}%`).join(', ')} of training wins`);
