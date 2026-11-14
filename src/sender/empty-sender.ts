import { existsSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, rpcUrlFor } from '../chains.ts';
import { createRpc } from '../rpc.ts';
import { REQUIRED_CONFIRMATION } from './live.ts';
import { emptyingAmount, PLAIN_TRANSFER_GAS } from './plan.ts';

/**
 * Returns what is left on the sender to the treasury. It can only send there, so it cannot be
 * pointed at a wrong address, and it refuses while the sender might still be sending.
 */

const STOP_FILE = 'data/STOP';
const key = process.env.SENDER_PRIVATE_KEY as `0x${string}` | undefined;
const treasury = process.env.TREASURY_ADDRESS as `0x${string}` | undefined;
if (!key || !treasury) throw new Error('SENDER_PRIVATE_KEY and TREASURY_ADDRESS must be set in .env');
if (process.env.SENDER_CONFIRM !== REQUIRED_CONFIRMATION) throw new Error(`Set SENDER_CONFIRM=${REQUIRED_CONFIRMATION} to send for real`);
if (!existsSync(STOP_FILE)) throw new Error(`Stop the sender first: create ${STOP_FILE}, press Ctrl+C in its window, then run this again`);

const rpc = createRpc(rpcUrlFor(CHAINS.ethereum!));
const account = privateKeyToAccount(key);
const [balance, block, priority, nonce] = await Promise.all([
  rpc.call<string>('eth_getBalance', [account.address, 'latest']),
  rpc.call<{ baseFeePerGas: string }>('eth_getBlockByNumber', ['latest', false]),
  rpc.call<string>('eth_maxPriorityFeePerGas', []),
  rpc.call<string>('eth_getTransactionCount', [account.address, 'pending']),
]);
const maxPriorityFeePerGas = BigInt(priority);
const maxFeePerGas = BigInt(block.baseFeePerGas) * 2n + maxPriorityFeePerGas;
const amount = emptyingAmount(BigInt(balance), maxFeePerGas);
console.log(`На кошельке отправителя: ${Number(BigInt(balance)) / 1e18} ETH. Уйдёт на ${treasury}: ${Number(amount) / 1e18} ETH`);
if (amount === 0n) throw new Error('Too little is left to pay even for the transfer');

const signed = await account.signTransaction({ chainId: 1, type: 'eip1559', to: treasury, value: amount, nonce: Number(BigInt(nonce)), gas: PLAIN_TRANSFER_GAS, maxFeePerGas, maxPriorityFeePerGas });
console.log(`Отправлено: ${await rpc.call<string>('eth_sendRawTransaction', [signed])}`);
