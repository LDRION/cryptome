import { toEventSelector } from 'viem';
import type { Log } from '../detect.ts';

/**
 * Finds transactions in which the chain pays whoever called: a reward, a fee or a bounty. Pure
 * functions over logs, so the scanner and the tests share them.
 */

export const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
/** eth_simulateV1 with traceTransfers reports native transfers as Transfer logs from this address. */
export const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO = '0x0000000000000000000000000000000000000000';

export interface Movement {
  token: string;
  from: string;
  to: string;
  amount: bigint;
}

const topicToAddress = (topic: string): string => `0x${topic.slice(-40)}`.toLowerCase();

/** ERC-20 transfers only: three topics separates them from ERC-721, whose tokenId is indexed. */
export function movementsOf(logs: readonly Log[]): Movement[] {
  const out: Movement[] = [];
  for (const log of logs) {
    if (log.topics[0] !== TRANSFER || log.topics.length !== 3 || log.data === '0x' || log.data.length < 3) continue;
    const amount = BigInt(log.data.slice(0, 66));
    if (amount === 0n) continue;
    out.push({ token: log.address.toLowerCase(), from: topicToAddress(log.topics[1]!), to: topicToAddress(log.topics[2]!), amount });
  }
  return out;
}

/** Net change per token for a group of addresses, ignoring transfers inside the group. */
export function netOf(movements: readonly Movement[], side: ReadonlySet<string>): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const m of movements) {
    const out = side.has(m.from);
    const into = side.has(m.to);
    if (out === into) continue;
    net.set(m.token, (net.get(m.token) ?? 0n) + (into ? m.amount : -m.amount));
  }
  return net;
}

export interface SideIncome {
  /** The one who paid and got nothing back from this side; a mint is credited to the token. */
  payer: string;
  /** Tokens the side ended up with. Never negative: the side spent nothing it had before. */
  net: Map<string, bigint>;
}

/**
 * A side earned when three things hold: whatever it sent out it had received in the same transaction,
 * so no money of its own went in; somebody paid it and got nothing back from it; and it kept something.
 * Swapping a reward on the way out still counts, while a swap, a deposit or a repayment does not, and
 * neither does an arbitrage, whose counterparties are all pools that are paid as well as paying.
 */
export function sideIncome(movements: readonly Movement[], side: ReadonlySet<string>): SideIncome | null {
  const net = netOf(movements, side);
  for (const amount of net.values()) if (amount < 0n) return null;
  if (![...net.values()].some((amount) => amount > 0n)) return null;

  const paidBySide = new Set<string>();
  for (const m of movements) if (side.has(m.from) && !side.has(m.to)) paidBySide.add(m.to);
  const oneWay = new Map<string, number>();
  for (const m of movements) {
    if (!side.has(m.to) || side.has(m.from) || paidBySide.has(m.from)) continue;
    const payer = m.from === ZERO ? m.token : m.from;
    oneWay.set(payer, (oneWay.get(payer) ?? 0) + 1);
  }
  const payer = [...oneWay].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (payer === undefined) return null;
  for (const [token, amount] of net) if (amount === 0n) net.delete(token);
  return { payer, net };
}

export type IncomeKind = 'direct' | 'contract';

export interface Income extends SideIncome {
  /** direct: the sender itself was paid, so the call can be replayed as is. contract: its own contract was. */
  kind: IncomeKind;
  recipient: string;
}

/** Native value paid in is invisible to token logs, so a transaction that sends any is left out. */
export function incomeOf(movements: readonly Movement[], from: string, to: string | null, value: bigint): Income | null {
  if (value !== 0n || movements.length === 0) return null;
  const sender = from.toLowerCase();
  const direct = sideIncome(movements, new Set([sender]));
  if (direct) return { kind: 'direct', recipient: sender, ...direct };
  if (to === null || to.toLowerCase() === sender) return null;
  const target = to.toLowerCase();
  const viaContract = sideIncome(movements, new Set([sender, target]));
  return viaContract && { kind: 'contract', recipient: target, ...viaContract };
}

/**
 * The best a fresh address could keep from a run of simulated calls, stopping after any of them: a
 * bot's later steps, such as a swap paid out to its own contract, would only take the reward away.
 */
export function bestPrefix(callLogs: readonly (readonly Log[] | null)[], who: string, value: (net: Map<string, bigint>) => number): { calls: number; usd: number; net: Map<string, bigint> } {
  const side = new Set([who.toLowerCase()]);
  let best = { calls: 0, usd: 0, net: new Map<string, bigint>() };
  const seen: Log[] = [];
  callLogs.forEach((logs, i) => {
    if (logs) seen.push(...logs);
    const net = netOf(movementsOf(seen), side);
    const usd = value(net);
    if (usd > best.usd) best = { calls: i + 1, usd, net };
  });
  return best;
}
