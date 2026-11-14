export interface CallFrame {
  type?: string;
  from: string;
  to?: string;
  value?: string;
  error?: string;
  calls?: CallFrame[];
}

export interface NativeFlows {
  toMiner: bigint;
  /** Signed native flow per counterparty: positive means the entity received it. */
  byCounterparty: Map<string, bigint>;
}

// A DELEGATECALL frame repeats its parent's value without moving any funds.
const MOVES_VALUE = new Set(['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT']);

/**
 * Collects native transfers from a callTracer tree, skipping reverted subtrees since
 * their transfers never happened. Wrapping and unwrapping are left out, so that native
 * and wrapped balances count as one asset. Any frame paying the miner counts, because
 * searchers often pay from a helper contract rather than from the executor itself.
 */
export function nativeFlows(root: CallFrame, miner: string, entity: ReadonlySet<string>, wrappedNative: string): NativeFlows {
  const flows: NativeFlows = { toMiner: 0n, byCounterparty: new Map() };
  const target = miner.toLowerCase();

  const add = (counterparty: string, amount: bigint): void => {
    flows.byCounterparty.set(counterparty, (flows.byCounterparty.get(counterparty) ?? 0n) + amount);
  };

  const walk = (frame: CallFrame): void => {
    if (frame.error) return;
    const value = BigInt(frame.value ?? 0);
    if (value > 0n && MOVES_VALUE.has((frame.type ?? '').toUpperCase())) {
      const from = frame.from.toLowerCase();
      const to = (frame.to ?? '').toLowerCase();
      if (to === target) {
        flows.toMiner += value;
      } else if (entity.has(from) && !entity.has(to) && to !== wrappedNative) {
        add(to, -value);
      } else if (entity.has(to) && !entity.has(from) && from !== wrappedNative) {
        add(from, value);
      }
    }
    for (const call of frame.calls ?? []) walk(call);
  };

  walk(root);
  return flows;
}

export interface RealProfitInput {
  /** The detector's value for the hit, in USD. */
  hitUsd: number;
  /** True when the hit's gain token is the wrapped native, whose value hitUsd already holds. */
  gainIsWrapped: boolean;
  /** Net wrapped native moved by Transfer events, in wei. */
  wrappedNet: bigint;
  /**
   * Net native exchanged with anyone but the miner, in wei. A send to a plain address
   * counts as spent too: a bot paying its owner in-transaction looks the same as a
   * router passing a user's funds through, and only the first is profit.
   */
  legsNet: bigint;
  toMiner: bigint;
  nativeUsd: number;
  gasUsd: number;
}

/**
 * Corrects a hit using the native flows that logs cannot show. A native DEX leg spends
 * ETH that token transfers never record, so without this the leg reads as profit.
 */
export function realProfit(input: RealProfitInput): { grossUsd: number; minerUsd: number; retainedUsd: number } {
  const toUsd = (wei: bigint): number => (Number(wei) / 1e18) * input.nativeUsd;
  const grossUsd = (input.gainIsWrapped ? 0 : input.hitUsd) + toUsd(input.wrappedNet + input.legsNet);
  const minerUsd = toUsd(input.toMiner);
  return { grossUsd, minerUsd, retainedUsd: grossUsd - minerUsd - input.gasUsd };
}
