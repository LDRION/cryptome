/**
 * Predicts which upcoming blocks a validator will build itself. Those blocks take only public
 * transactions, because private bundles have no way in, and in the replay the gaps left open
 * at their start were almost never taken. A proposer registered with no relay cannot receive a
 * builder's block, so the prediction needs no guesswork about auctions.
 */

export const SECONDS_PER_SLOT = 12;
export const SLOTS_PER_EPOCH = 32;
export const MAINNET_GENESIS = 1_606_824_023;

export const RELAYS = [
  'https://boost-relay.flashbots.net',
  'https://bloxroute.regulated.blxrbdn.com',
  'https://bloxroute.max-profit.blxrbdn.com',
  'https://agnostic-relay.net',
  'https://mainnet.aestus.live',
  'https://global.titanrelay.xyz',
  'https://regional.titanrelay.xyz',
  'https://relay.ethgas.com',
  'https://relay.btcs.com',
  'https://relay.ultrasound.money',
  'https://mainnet-relay.securerpc.com',
];

export type BlockKind = 'validator' | 'blank' | 'builder';

const EXECUTION_CLIENT = /geth|besu|reth|nethermind|erigon/i;

/** Execution clients sign their own blocks by default, while builders write their own name. */
export function blockKind(extraData: string): BlockKind {
  const text = Buffer.from(extraData.replace(/^0x/, ''), 'hex').toString('latin1');
  if (EXECUTION_CLIENT.test(text)) return 'validator';
  return text.replace(/[^\x21-\x7e]/g, '') === '' ? 'blank' : 'builder';
}

export const slotOf = (timestamp: number, genesis: number = MAINNET_GENESIS): number => Math.floor((timestamp - genesis) / SECONDS_PER_SLOT);

/** Slots whose proposer told at least one relay that it accepts blocks from builders. */
export function registeredSlots(relayLists: { slot: string | number }[][]): Set<number> {
  const slots = new Set<number>();
  for (const list of relayLists) for (const entry of list) slots.add(Number(entry.slot));
  return slots;
}

export interface RelayEntry {
  slot: string | number;
  entry?: { message?: { fee_recipient?: string } };
}

/** The address each upcoming proposer registered, which shows who is really behind a slot. */
export function recipientsBySlot(relayLists: RelayEntry[][]): Map<number, string> {
  const recipients = new Map<number, string>();
  for (const list of relayLists) {
    for (const entry of list) {
      const recipient = entry.entry?.message?.fee_recipient;
      if (recipient) recipients.set(Number(entry.slot), recipient.toLowerCase());
    }
  }
  return recipients;
}

/** What one relay knows about upcoming proposers, or null if it did not answer. */
export async function fetchRelayList(base: string, timeoutMs = 8000): Promise<RelayEntry[] | null> {
  try {
    const response = await fetch(`${base}/relay/v1/builder/validators`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? (body as RelayEntry[]) : null;
  } catch {
    return null;
  }
}

export interface PredictionStats {
  /** Blocks compared, by what was predicted and what the block turned out to be. */
  predictedSelfBuilt: Record<BlockKind, number>;
  predictedBuilder: Record<BlockKind, number>;
  /** Blocks skipped because too few relays answered to trust a missing registration. */
  skipped: number;
}

const newRow = (): Record<BlockKind, number> => ({ validator: 0, blank: 0, builder: 0 });

export const newPredictionStats = (): PredictionStats => ({ predictedSelfBuilt: newRow(), predictedBuilder: newRow(), skipped: 0 });

export function addPrediction(stats: PredictionStats, predictedSelfBuilt: boolean, actual: BlockKind): void {
  (predictedSelfBuilt ? stats.predictedSelfBuilt : stats.predictedBuilder)[actual]++;
}

const total = (row: Record<BlockKind, number>): number => row.validator + row.blank + row.builder;

/** Precision: of the blocks we would act on, how many were really self-built. Recall: how many we caught. */
export function predictionQuality(stats: PredictionStats): { precision: number; recall: number; acted: number } {
  const acted = total(stats.predictedSelfBuilt);
  const hits = acted - stats.predictedSelfBuilt.builder;
  const missed = stats.predictedBuilder.validator + stats.predictedBuilder.blank;
  return { precision: acted > 0 ? hits / acted : 0, recall: hits + missed > 0 ? hits / (hits + missed) : 0, acted };
}
