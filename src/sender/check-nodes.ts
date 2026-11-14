import { CHAINS, rpcUrlFor } from '../chains.ts';
import { createRpc } from '../rpc.ts';
import { PUBLIC_NODES } from './broadcast.ts';

/**
 * Says whether the nodes the sender needs can be reached from this connection, for example after
 * turning a VPN off. It only reads, spends nothing and needs no key. URLs are not printed, since
 * one of them holds a private key to a paid service.
 */

const TIMEOUT_MS = 8000;
const WS_URL = 'wss://ethereum-rpc.publicnode.com';
const chain = CHAINS.ethereum!;

interface Check {
  name: string;
  needed: string;
  url: string | undefined;
}

const checks: Check[] = [
  ...PUBLIC_NODES.filter((node) => node.name === 'tenderly' || node.name === 'nodies').map((node) => ({ name: node.name, needed: 'разносит сделки по сети', url: node.url })),
  ...PUBLIC_NODES.filter((node) => node.name !== 'tenderly' && node.name !== 'nodies').map((node) => ({ name: node.name, needed: 'запасной путь для сделок', url: node.url })),
  { name: 'логи блоков', needed: 'движок читает блоки', url: process.env.LOGS_RPC_URL_ETHEREUM ?? chain.defaultLogsRpc },
  { name: 'основная нода', needed: 'баланс и квитанции', url: rpcUrlFor(chain) },
  { name: 'dRPC с ключом', needed: 'проверка сделок в EVM', url: process.env.TRACE_RPC_URL_ETHEREUM },
];

const reach = async (check: Check): Promise<{ ok: boolean; ms: number; error?: string }> => {
  const started = Date.now();
  if (!check.url) return { ok: false, ms: 0, error: 'не задан адрес' };
  try {
    const head = await createRpc(check.url, 0, TIMEOUT_MS).call<string>('eth_blockNumber', []);
    return { ok: BigInt(head) > 0n, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: (err as Error).message.replace(/https?:\/\/\S+/g, '').slice(0, 70) };
  }
};

const stream = (): Promise<{ ok: boolean; ms: number }> =>
  new Promise((resolve) => {
    const started = Date.now();
    const ws = new WebSocket(WS_URL);
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      ws.onmessage = null;
      ws.onerror = null;
      ws.close();
      resolve({ ok, ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish(false), TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
    ws.onmessage = () => finish(true);
    ws.onerror = () => finish(false);
  });

const results = await Promise.all(checks.map(reach));
const live = await stream();
results.forEach((result, i) => {
  const check = checks[i]!;
  console.log(`${result.ok ? 'OK    ' : 'НЕТ   '} ${check.name.padEnd(16)} ${String(result.ms).padStart(5)} мс  ${check.needed}${result.error ? ` (${result.error})` : ''}`);
});
console.log(`${live.ok ? 'OK    ' : 'НЕТ   '} ${'поток блоков'.padEnd(16)} ${String(live.ms).padStart(5)} мс  новые блоки и мемпул`);

const named = (name: string): boolean => results[checks.findIndex((check) => check.name === name)]?.ok ?? false;
const spreads = named('tenderly') || named('nodies');
const reads = named('логи блоков') || named('основная нода');
const proves = named('dRPC с ключом');
console.log('');
if (spreads && reads && proves && live.ok) console.log('Итог: с этого соединения отправитель работать может.');
else console.log(`Итог: НЕ РАБОТАЕТ как надо. ${spreads ? '' : 'Сделки не дойдут до сети. '}${reads ? '' : 'Блоки не читаются. '}${proves ? '' : 'Сделки не проверить в EVM. '}${live.ok ? '' : 'Нет потока блоков. '}Деньги в безопасности, но заработка не будет: включи VPN обратно.`);
process.exit(0);
