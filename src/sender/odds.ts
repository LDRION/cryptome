import { readdirSync, readFileSync } from 'node:fs';
import type { BlockKind, RelayEntry } from '../paper/proposers.ts';
import { recipientsBySlot, registeredSlots } from '../paper/proposers.ts';
import { FAILURES_PER_WIN } from './plan.ts';

/**
 * How likely the next block is to be self-built, from what is public before it: who proposes the
 * slot, whether they registered with any relay, and how that fee recipient has behaved. Builder
 * blocks cannot be ruled out, as most self-built blocks come from registered proposers and hold most
 * of the money. So a trade is weighed against its slot's odds instead of slots being skipped outright.
 */

/** Of the attempts aimed at a self-built block, about this many win. */
const WIN_GIVEN_SELF_BUILT = 2 / 3;
/** How many blocks of the average a recipient's own record has to outweigh. */
const PRIOR_BLOCKS = 20;
/**
 * Asks a trade to clear twice its break-even. On the 66 real attempts so far this halves what failures
 * on builder blocks cost and keeps all 4 shots at self-built blocks, while on recorded trades it gives
 * up about 1% of the modelled wins. At three times it starts dropping wins of $9 to $36.
 */
const SAFETY = 2;
const MIN_RELAYS = 4;
const MIN_HISTORY_BLOCKS = 500;
const NO_RELAY = 'no-relay';
const UNKNOWN_RECIPIENT = 'unknown';

const isOwn = (kind: BlockKind): boolean => kind !== 'builder';

export class SlotOdds {
  private readonly records = new Map<string, { blocks: number; own: number }>();
  private blocks = 0;
  private own = 0;
  private readonly registered = new Set<number>();
  private readonly recipients = new Map<number, string>();
  private coveredFrom = 0;
  private coveredTo = 0;
  relaysAnswering = 0;

  get history(): { blocks: number; own: number } {
    return { blocks: this.blocks, own: this.own };
  }

  learn(key: string, kind: BlockKind): void {
    const record = this.records.get(key) ?? { blocks: 0, own: 0 };
    record.blocks++;
    this.blocks++;
    if (isOwn(kind)) {
      record.own++;
      this.own++;
    }
    this.records.set(key, record);
  }

  /** Takes what the relays say about upcoming proposers. A relay that did not answer is left out. */
  noteRelays(lists: RelayEntry[][]): void {
    this.relaysAnswering = lists.length;
    const slots = registeredSlots(lists);
    if (slots.size === 0) return;
    for (const slot of slots) this.registered.add(slot);
    for (const [slot, recipient] of recipientsBySlot(lists)) this.recipients.set(slot, recipient);
    if (this.coveredFrom === 0) this.coveredFrom = Math.min(...slots);
    this.coveredTo = Math.max(this.coveredTo, ...slots);
  }

  /** What is known about who stands behind this slot, or null if the relays do not cover it. */
  keyOf(slot: number): string | null {
    if (this.relaysAnswering < MIN_RELAYS || this.coveredFrom === 0 || slot < this.coveredFrom || slot > this.coveredTo) return null;
    return this.registered.has(slot) ? (this.recipients.get(slot) ?? UNKNOWN_RECIPIENT) : NO_RELAY;
  }

  chanceOf(key: string): number {
    const average = this.own / this.blocks;
    const record = this.records.get(key) ?? { blocks: 0, own: 0 };
    return (record.own + average * PRIOR_BLOCKS) / (record.blocks + PRIOR_BLOCKS);
  }

  /** A proposer on no relay can only build for itself, which held in 95-100% of such slots. */
  isNearlySure(slot: number): boolean {
    return this.keyOf(slot) === NO_RELAY;
  }

  /** The chance this slot's block is self-built, or null when the relays or the history say too little. */
  chanceAt(slot: number): number | null {
    const key = this.keyOf(slot);
    return key === null || this.blocks < MIN_HISTORY_BLOCKS ? null : this.chanceOf(key);
  }

  /** How many failures to expect per win in this slot. With nothing to go on, the usual figure. */
  failuresPerWinAt(slot: number): number {
    const chance = this.chanceAt(slot);
    if (chance === null) return FAILURES_PER_WIN;
    const win = chance * WIN_GIVEN_SELF_BUILT;
    return ((1 - win) / win) * SAFETY;
  }

  /** Adds a finished block to the record. Returns the line to keep, or null if its slot was not covered. */
  noteBlock(block: number, slot: number, kind: BlockKind): string | null {
    const key = this.keyOf(slot);
    if (key === null) return null;
    this.learn(key, kind);
    const recipient = key === NO_RELAY || key === UNKNOWN_RECIPIENT ? null : key;
    return JSON.stringify({ block, slot, predicted: key === NO_RELAY, kind, recipient });
  }
}

/** Builds the record from the saved proposer logs. Several logs may cover one block, which counts once. */
export function loadSlotOdds(dir: string): SlotOdds {
  const odds = new SlotOdds();
  const seen = new Set<number>();
  for (const file of readdirSync(dir).filter((name) => /^proposers-.*\.jsonl$/.test(name))) {
    for (const line of readFileSync(`${dir}/${file}`, 'utf8').split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line) as { block: number; predicted: boolean; kind: BlockKind; recipient: string | null };
      if (seen.has(row.block)) continue;
      seen.add(row.block);
      odds.learn(row.predicted ? NO_RELAY : (row.recipient ?? UNKNOWN_RECIPIENT), row.kind);
    }
  }
  return odds;
}
