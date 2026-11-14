import { writeFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { createRpc, type Rpc } from '../rpc.ts';
import { broadcast, PUBLIC_NODES } from './broadcast.ts';
import { REQUIRED_CONFIRMATION } from './live.ts';
import { PLAIN_TRANSFER_GAS } from './plan.ts';

/**
 * Finds out which entrance really reaches the public mempool. It sends one empty transfer to the
 * sender's own address through each node in turn, and watches when the other nodes learn of it.
 * Each costs a fraction of a cent. Run it only while the sender itself is stopped.
 */

const TIP_WEI_PER_GAS = 100_000_000n;
const MAX_BASE_FEE_WEI = 2_000_000_000n;
const WAIT_MS = 60_000;
const POLL_MS = 400;
const FEE_BUMP_PERCENT = 300n;

const key = process.env.SENDER_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error('SENDER_PRIVATE_KEY must be set in .env');
if (process.env.SENDER_CONFIRM !== REQUIRED_CONFIRMATION) throw new Error(`Set SENDER_CONFIRM=${REQUIRED_CONFIRMATION} to send for real`);

const account = privateKeyToAccount(key);
const nodes = PUBLIC_NODES.map(({ name, url }) => ({ name, rpc: createRpc(url, 0) }));
const main: Rpc = createRpc(PUBLIC_NODES[0]!.url, 0);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Trial {
  entrance: string;
  accepted: boolean;
  error?: string;
  /** Milliseconds until each other node knew the transaction. */
  seenBy: Record<string, number>;
  minedBlock?: number;
  blocksWaited?: number;
  extraData?: string;
  feeWei?: string;
  rescued?: boolean;
}

const knows = async (rpc: Rpc, hash: string): Promise<boolean> => {
  try {
    await rpc.call('eth_getTransactionByHash', [hash]);
    return true;
  } catch {
    return false;
  }
};
const receiptOf = (hash: string): Promise<{ blockNumber: string; gasUsed: string; effectiveGasPrice: string } | null> =>
  main.call<{ blockNumber: string; gasUsed: string; effectiveGasPrice: string }>('eth_getTransactionReceipt', [hash]).catch(() => null);
const headNumber = async (): Promise<number> => Number(BigInt(await main.call<string>('eth_blockNumber', [])));

const trials: Trial[] = [];
for (const entrance of nodes) {
  const [block, latest, pending] = await Promise.all([
    main.call<{ baseFeePerGas: string }>('eth_getBlockByNumber', ['latest', false]),
    main.call<string>('eth_getTransactionCount', [account.address, 'latest']),
    main.call<string>('eth_getTransactionCount', [account.address, 'pending']),
  ]);
  if (latest !== pending) throw new Error('An earlier transaction is still pending. Stop the sender, wait for it to land, then run this again.');
  const base = BigInt(block.baseFeePerGas);
  if (base > MAX_BASE_FEE_WEI) throw new Error(`Base fee is unusually high (${base} wei), try later`);
  const nonce = Number(BigInt(latest));
  const maxFeePerGas = base * 2n + TIP_WEI_PER_GAS;
  const signed = await account.signTransaction({ chainId: 1, type: 'eip1559', to: account.address, value: 0n, nonce, gas: PLAIN_TRANSFER_GAS, maxFeePerGas, maxPriorityFeePerGas: TIP_WEI_PER_GAS });

  const trial: Trial = { entrance: entrance.name, accepted: false, seenBy: {} };
  trials.push(trial);
  const startedBlock = await headNumber();
  const started = Date.now();
  const { accepted, answers } = broadcast([entrance], signed);
  let hash: `0x${string}`;
  try {
    hash = await accepted;
    trial.accepted = true;
  } catch {
    trial.error = (await answers)[0]?.error ?? 'refused';
    console.log(`${entrance.name}: не принял (${trial.error})`);
    continue;
  }

  const witnesses = nodes.filter((node) => node !== entrance);
  let receipt = await receiptOf(hash);
  while (!receipt && Date.now() - started < WAIT_MS) {
    await Promise.all(
      witnesses
        .filter((node) => trial.seenBy[node.name] === undefined)
        .map(async (node) => {
          if (await knows(node.rpc, hash)) trial.seenBy[node.name] = Date.now() - started;
        }),
    );
    await sleep(POLL_MS);
    receipt = await receiptOf(hash);
  }

  if (!receipt) {
    // Not even the entrance got it mined. Same nonce through all nodes at once, so nothing stays stuck.
    trial.rescued = true;
    const rescue = await account.signTransaction({ chainId: 1, type: 'eip1559', to: account.address, value: 0n, nonce, gas: PLAIN_TRANSFER_GAS, maxFeePerGas: (maxFeePerGas * FEE_BUMP_PERCENT) / 100n, maxPriorityFeePerGas: (TIP_WEI_PER_GAS * FEE_BUMP_PERCENT) / 100n });
    const rescueHash = await broadcast(nodes, rescue).accepted;
    while (!receipt) {
      await sleep(POLL_MS * 5);
      receipt = (await receiptOf(hash)) ?? (await receiptOf(rescueHash));
    }
  }

  trial.minedBlock = Number(BigInt(receipt.blockNumber));
  trial.blocksWaited = trial.minedBlock - startedBlock;
  trial.feeWei = (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString();
  trial.extraData = Buffer.from((await main.call<{ extraData: string }>('eth_getBlockByNumber', [receipt.blockNumber, false])).extraData.slice(2), 'hex')
    .toString('latin1')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 24);
  const seen = Object.entries(trial.seenBy)
    .sort((a, b) => a[1] - b[1])
    .map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)} с`);
  console.log(`${entrance.name}: блок через ${trial.blocksWaited} (${trial.extraData})${trial.rescued ? ', ПРИШЛОСЬ ЗАМЕНЯТЬ' : ''}; увидели: ${seen.join(', ') || 'НИКТО'}; не увидели: ${witnesses.filter((node) => trial.seenBy[node.name] === undefined).map((node) => node.name).join(', ') || 'нет таких'}`);
}

const file = `data/probe-${new Date().toISOString().replaceAll(':', '-')}.json`;
await writeFile(file, JSON.stringify(trials, null, 2));
const spent = trials.reduce((sum, trial) => sum + BigInt(trial.feeWei ?? 0), 0n);
console.log(`\nПотрачено ${Number(spent) / 1e18} ETH. Результат: ${file}`);
process.exit(0);
