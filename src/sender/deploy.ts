import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { encodeDeployData, getContractAddress, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { deployedMatchesBuild } from '../executor.ts';
import { createPriceReader } from '../prices.ts';
import { createRpc } from '../rpc.ts';
import { broadcast, PUBLIC_NODES } from './broadcast.ts';
import { REQUIRED_CONFIRMATION } from './live.ts';

/**
 * Prepares the contract's deployment and reports its cost. It sends nothing unless --execute
 * is given together with the confirmation, a key and a treasury address. Once the contract is
 * mined and proven to be this build, it writes the new address into .env.
 */

const ENV_FILE = '.env';
/** Nothing hurries a deployment, and on 2.2M gas a trade's tip would cost half a dollar more. */
const DEPLOY_TIP_WEI = 20_000_000n;
const WAIT_MS = 10 * 60_000;
const POLL_MS = 3000;

const { values: args } = parseArgs({ options: { treasury: { type: 'string' }, execute: { type: 'boolean', default: false } } });

const chain = CHAINS.ethereum!;
const rpc = createRpc(rpcUrlFor(chain));
const artifact = JSON.parse(await readFile(new URL('../../contracts/Executor.json', import.meta.url), 'utf8')) as { abi: Abi; bytecode: `0x${string}` };
const SAMPLE_TREASURY = '0x000000000000000000000000000000000000beef';
const treasuryGiven = args.treasury ?? process.env.TREASURY_ADDRESS;
const treasury = (treasuryGiven ?? SAMPLE_TREASURY) as `0x${string}`;
if (!/^0x[0-9a-fA-F]{40}$/.test(treasury)) throw new Error('Treasury must be a full address');

const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [treasury] });
const gas = BigInt(await rpc.call<string>('eth_estimateGas', [{ from: '0x000000000000000000000000000000000000dEaD', data }]));
const block = await rpc.call<{ baseFeePerGas: string; timestamp: string }>('eth_getBlockByNumber', ['latest', false]);
const major = await (await createPriceReader())(Number(BigInt(block.timestamp)) - 30);
const gasPrice = BigInt(block.baseFeePerGas) * 2n + DEPLOY_TIP_WEI;
const usdOf = (wei: bigint): string => `$${((Number(wei) / 1e18) * major.ETH).toFixed(2)}`;
console.log(`Размер контракта: ${(data.length - 2) / 2} байт. Газ на развёртывание: ${gas}`);
console.log(`Сейчас: база ${(Number(block.baseFeePerGas) / 1e9).toFixed(3)} гвей, ETH $${major.ETH.toFixed(0)}. Стоимость около ${usdOf(gas * (BigInt(block.baseFeePerGas) + DEPLOY_TIP_WEI))}, не выше ${usdOf(((gas * 120n) / 100n) * gasPrice)}`);
console.log(`Прибыль навсегда будет уходить на: ${treasury}${treasuryGiven ? '' : ' (пример, адрес не задан)'}`);

if (args.execute) {
  if (process.env.SENDER_CONFIRM !== REQUIRED_CONFIRMATION) throw new Error(`Set SENDER_CONFIRM=${REQUIRED_CONFIRMATION} to deploy for real`);
  if (!treasuryGiven) throw new Error('Pass --treasury with the address that will receive profit');
  const key = process.env.SENDER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) throw new Error('SENDER_PRIVATE_KEY is not set');
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() === treasury.toLowerCase()) throw new Error('The treasury must not be the sender: a stolen key would then reach the profit');

  const nonce = Number(BigInt(await rpc.call<string>('eth_getTransactionCount', [account.address, 'pending'])));
  const signed = await account.signTransaction({ chainId: 1, type: 'eip1559', data, nonce, gas: (gas * 120n) / 100n, maxFeePerGas: gasPrice, maxPriorityFeePerGas: DEPLOY_TIP_WEI, value: 0n });
  const nodes = PUBLIC_NODES.map(({ name, url }) => ({ name, rpc: createRpc(url, 0) }));
  const hash = await broadcast(nodes, signed).accepted;
  const address = getContractAddress({ from: account.address, nonce: BigInt(nonce) });
  console.log(`Отправлено: ${hash}`);
  console.log(`Адрес контракта: ${address}`);

  const quiet = createRpc(rpcUrlFor(chain), 0);
  const deadline = Date.now() + WAIT_MS;
  let status: string | null = null;
  while (status === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    status = await quiet.call<{ status: string }>('eth_getTransactionReceipt', [hash]).then((receipt) => receipt.status, () => null);
  }
  if (status !== '0x1') throw new Error(status ? 'The deployment reverted, .env is unchanged' : 'Not mined yet, .env is unchanged. Check the hash on etherscan.io');
  if (!(await deployedMatchesBuild(rpc, address, account.address, treasury))) throw new Error('The code on chain is not this build, .env is unchanged');

  const env = await readFile(ENV_FILE, 'utf8');
  const line = `EXECUTOR_ADDRESS=${address}`;
  await writeFile(ENV_FILE, /^EXECUTOR_ADDRESS=.*$/m.test(env) ? env.replace(/^EXECUTOR_ADDRESS=.*$/m, line) : `${env.trimEnd()}\n${line}\n`);
  console.log('Контракт в сети совпадает со сборкой, новый адрес записан в .env. Готово.');
}
process.exit(0);
