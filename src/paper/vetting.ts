import { encodeAbiParameters, keccak256 } from 'viem';
import type { PoolMeta } from './pools.ts';

export interface V4Key {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Fee value marking a pool whose hook sets the fee on every swap. */
const DYNAMIC_FEE_FLAG = 0x800000;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export function v4PoolId(key: V4Key): string {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0 as `0x${string}`, key.currency1 as `0x${string}`, key.fee, key.tickSpacing, key.hooks as `0x${string}`],
    ),
  );
}

export function parseInitialize(log: { topics: string[]; data: string }): V4Key {
  const word = (i: number): string => log.data.slice(2 + i * 64, 2 + (i + 1) * 64);
  return {
    currency0: `0x${log.topics[2]!.slice(-40)}`,
    currency1: `0x${log.topics[3]!.slice(-40)}`,
    fee: Number(BigInt(`0x${word(0)}`)),
    tickSpacing: Number(BigInt.asIntN(256, BigInt(`0x${word(1)}`))),
    hooks: `0x${word(2).slice(-40)}`,
  };
}

/**
 * Null for pools with a hook, which can change swap terms arbitrarily at any moment, so
 * neither the model nor past swaps can vouch for them. Native ETH routes as the wrapped
 * token, since a bot can convert between them inside one transaction.
 */
export function v4Meta(id: string, key: V4Key, wrappedNative: string): PoolMeta | null {
  if (key.hooks !== ZERO_ADDRESS || key.fee === DYNAMIC_FEE_FLAG) return null;
  const route = (currency: string): string => (currency === ZERO_ADDRESS ? wrappedNative : currency);
  return {
    address: id.toLowerCase(),
    kind: 'v4',
    token0: route(key.currency0),
    token1: route(key.currency1),
    fee: key.fee,
    tickSpacing: key.tickSpacing,
  };
}

interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

/**
 * A transfer tax makes the amount a pool reports differ from what actually moved, because
 * the token splits the payment. So an untaxed token shows one transfer out of the pool for
 * exactly the amount in its swap log.
 */
export function outputTransferMatches(logs: ReceiptLog[], token: string, pool: string, amount: bigint): boolean {
  return logs.some((log) => {
    if (log.address.toLowerCase() !== token || log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) return false;
    return `0x${log.topics[1]!.slice(-40)}`.toLowerCase() === pool && BigInt(log.data) === amount;
  });
}

export const MIN_TRANSFER_CHECKS = 2;

/** Vetted only with enough evidence and no contradiction: a single mismatch rejects it. */
export function tokenPasses(results: boolean[]): boolean {
  return results.length >= MIN_TRANSFER_CHECKS && results.every(Boolean);
}
