import { poolKeyOf, V4_POOL_MANAGER } from './pools.ts';

/**
 * Records which transactions could be seen before they landed. Read-only: nothing here
 * sends anything. The public mempool gives real hashes. MEV-Share does not, because its
 * event hashes do not match mined transactions, so its hints are matched by content.
 */

export type Visibility = 'mempool' | 'mev-share-exact' | 'mev-share-topics' | 'mev-share-possible' | 'unseen';

type Stream = 'mempool' | 'mevShare';

export interface SwapLog {
  address: string;
  data: string;
  topics?: string[];
}

interface PoolHint {
  at: number;
  topics: string[];
  fromManager: boolean;
}

/** A stream this quiet is treated as down. Both carry several events per second. */
const SILENCE_MS = 30_000;
/** A stream must have been up this long before a block counts as covered. */
const SETTLE_MS = 30_000;
/** A pool hint this recent might be the transaction that landed. Two slots. */
const HINT_WINDOW_MS = 24_000;
const KEEP_MS = 3_600_000;
const HIDDEN = /^0x0*$/;

export class PendingTracker {
  private readonly txs = new Map<string, number>();
  private readonly exactHints = new Map<string, number>();
  private readonly poolHints = new Map<string, PoolHint[]>();
  private readonly lastEvent: Record<Stream, number> = { mempool: 0, mevShare: 0 };
  private readonly upSince: Record<Stream, number> = { mempool: 0, mevShare: 0 };

  private touch(stream: Stream, now: number): void {
    if (now - this.lastEvent[stream] > SILENCE_MS) this.upSince[stream] = now;
    this.lastEvent[stream] = now;
  }

  noteTransaction(hash: string, now: number): void {
    this.touch('mempool', now);
    if (!this.txs.has(hash)) this.txs.set(hash, now);
  }

  /** Any MEV-Share event proves the stream is alive, even one with no usable logs. */
  noteHintEvent(logs: SwapLog[], now: number): void {
    this.touch('mevShare', now);
    for (const log of logs) {
      const pool = poolKeyOf(log);
      const hints = this.poolHints.get(pool) ?? [];
      hints.push({ at: now, topics: log.topics ?? [], fromManager: log.address.toLowerCase() === V4_POOL_MANAGER });
      this.poolHints.set(pool, hints);
      if (log.data && !HIDDEN.test(log.data)) {
        const key = `${pool}|${log.data}`;
        if (!this.exactHints.has(key)) this.exactHints.set(key, now);
      }
    }
  }

  /** False during outages, so that time we were blind does not read as hidden flow. */
  isCovered(blockMs: number, now: number): boolean {
    return (['mempool', 'mevShare'] as const).every((stream) => {
      return this.lastEvent[stream] > 0 && now - this.lastEvent[stream] <= SILENCE_MS && blockMs - this.upSince[stream] >= SETTLE_MS;
    });
  }

  /** How early the transaction that landed in a block was visible, best evidence first. */
  classify(txHash: string, logs: SwapLog[], blockMs: number): Visibility {
    const seenAt = this.txs.get(txHash);
    if (seenAt !== undefined && seenAt < blockMs) return 'mempool';

    for (const log of logs) {
      const at = this.exactHints.get(`${poolKeyOf(log)}|${log.data}`);
      if (at !== undefined && at < blockMs) return 'mev-share-exact';
    }

    let possible = false;
    for (const log of logs) {
      const recent = (this.poolHints.get(poolKeyOf(log)) ?? []).filter((hint) => hint.at < blockMs && blockMs - hint.at <= HINT_WINDOW_MS);
      if (recent.length > 0) possible = true;
      if (recent.some((hint) => revealedTopicsMatch(hint, log.topics ?? []))) return 'mev-share-topics';
    }
    return possible ? 'mev-share-possible' : 'unseen';
  }

  prune(now: number): void {
    for (const [key, at] of this.txs) if (now - at > KEEP_MS) this.txs.delete(key);
    for (const [key, at] of this.exactHints) if (now - at > KEEP_MS) this.exactHints.delete(key);
    for (const [pool, hints] of this.poolHints) {
      const recent = hints.filter((hint) => now - hint.at <= KEEP_MS);
      if (recent.length > 0) this.poolHints.set(pool, recent);
      else this.poolHints.delete(pool);
    }
  }
}

/**
 * Senders and recipients the hint reveals must all match the swap that landed. They exclude
 * unrelated trades on the same pool far better than timing alone. On V4 the pool id sits in
 * the first topic and already picked this pool, so it proves nothing further.
 */
function revealedTopicsMatch(hint: PoolHint, landed: string[]): boolean {
  const first = hint.fromManager ? 2 : 1;
  let revealed = 0;
  for (let i = first; i < hint.topics.length; i++) {
    const topic = hint.topics[i];
    if (!topic || HIDDEN.test(topic)) continue;
    if (topic.toLowerCase() !== landed[i]?.toLowerCase()) return false;
    revealed++;
  }
  return revealed > 0;
}

export interface VisibilityBucket {
  minUsd: number;
  count: number;
  usd: number;
  byClass: Record<Visibility, { count: number; usd: number }>;
}

export interface VisibilityStats {
  blocksCovered: number;
  blocksExcluded: number;
  buckets: VisibilityBucket[];
}

export function newVisibilityStats(thresholds = [0, 10, 100]): VisibilityStats {
  const emptyClasses = (): VisibilityBucket['byClass'] => ({
    mempool: { count: 0, usd: 0 },
    'mev-share-exact': { count: 0, usd: 0 },
    'mev-share-topics': { count: 0, usd: 0 },
    'mev-share-possible': { count: 0, usd: 0 },
    unseen: { count: 0, usd: 0 },
  });
  return {
    blocksCovered: 0,
    blocksExcluded: 0,
    buckets: thresholds.map((minUsd) => ({ minUsd, count: 0, usd: 0, byClass: emptyClasses() })),
  };
}

/** A gap's size picks its buckets. Its money is then split by who created which part. */
export function addGap(stats: VisibilityStats, gapUsd: number, parts: { usd: number; visibility: Visibility }[]): void {
  for (const bucket of stats.buckets) {
    if (gapUsd < bucket.minUsd) continue;
    bucket.count++;
    bucket.usd += gapUsd;
    for (const { usd, visibility } of parts) {
      bucket.byClass[visibility].count++;
      bucket.byClass[visibility].usd += usd;
    }
  }
}

const MEV_SHARE_URL = 'https://mev-share.flashbots.net';
const MEMPOOL_URL = 'wss://ethereum-rpc.publicnode.com';
const WATCHDOG_MS = 60_000;
const RETRY_MS = 3000;

export type StreamMessage = { kind: 'transaction'; hash: string; tx?: Record<string, string> } | { kind: 'head'; header: Record<string, string> };

/** Nodes also send confirmations and errors on this socket, so anything unexpected is null. */
export function parseStreamMessage(text: string): StreamMessage | null {
  let message: { method?: string; params?: { result?: unknown } } | null;
  try {
    message = JSON.parse(text) as typeof message;
  } catch {
    return null;
  }
  if (message?.method !== 'eth_subscription') return null;
  const result = message.params?.result;
  if (typeof result === 'string') return { kind: 'transaction', hash: result };
  if (typeof result !== 'object' || result === null) return null;
  const fields = result as Record<string, string>;
  if (fields.parentHash) return { kind: 'head', header: fields };
  if (!fields.hash) return null;
  return fields.input === undefined ? { kind: 'transaction', hash: fields.hash } : { kind: 'transaction', hash: fields.hash, tx: fields };
}

export interface StreamHandlers {
  say: (message: string) => void;
  /** Receives each new block header the moment the node pushes it. */
  onHead?: (header: Record<string, string>) => void;
  /** Asks the node to push whole pending transactions rather than only their hashes. */
  fullTransactions?: boolean;
  /** Receives each pending transaction the moment the node pushes it. */
  onTransaction?: (hash: string, now: number, tx?: Record<string, string>) => void;
}

/** Keeps the streams connected until stopped, reconnecting on errors and silent stalls. */
export function connectStreams(tracker: PendingTracker, handlers: StreamHandlers): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let abort: AbortController | null = null;

  const openMempool = (): void => {
    if (stopped) return;
    const ws = new WebSocket(MEMPOOL_URL);
    socket = ws;
    let last = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - last > WATCHDOG_MS) ws.close();
    }, WATCHDOG_MS);
    ws.onopen = () => {
      handlers.say('Поток мемпула подключён');
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: handlers.fullTransactions ? ['newPendingTransactions', true] : ['newPendingTransactions'] }));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newHeads'] }));
    };
    ws.onmessage = (event) => {
      last = Date.now();
      // An exception here would escape to the event loop and end the whole run.
      try {
        const message = parseStreamMessage(String(event.data));
        if (message?.kind === 'transaction') {
          tracker.noteTransaction(message.hash, last);
          handlers.onTransaction?.(message.hash, last, message.tx);
        } else if (message?.kind === 'head') handlers.onHead?.(message.header);
      } catch (err) {
        handlers.say(`Сообщение потока пропущено: ${(err as Error).message}`);
      }
    };
    ws.onclose = () => {
      clearInterval(watchdog);
      if (!stopped) setTimeout(openMempool, RETRY_MS);
    };
    ws.onerror = () => ws.close();
  };

  const readHints = async (): Promise<void> => {
    while (!stopped) {
      const controller = new AbortController();
      abort = controller;
      let last = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - last > WATCHDOG_MS) controller.abort();
      }, WATCHDOG_MS);
      try {
        const response = await fetch(MEV_SHARE_URL, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
        if (!response.body) throw new Error('empty stream');
        handlers.say('Поток MEV-Share подключён');
        let buffer = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          last = Date.now();
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (!line.startsWith('data:')) continue;
            const body = line.slice(5).trim();
            if (!body.startsWith('{')) continue;
            try {
              const parsed = JSON.parse(body) as { logs?: { address?: string; data?: string; topics?: string[] }[] };
              const logs = (parsed.logs ?? []).filter((log) => log.address).map((log) => ({ address: log.address!, data: log.data ?? '0x', topics: log.topics ?? [] }));
              tracker.noteHintEvent(logs, last);
            } catch {
              // One malformed event should not cost the whole stream.
            }
          }
        }
      } catch {
        // Reconnects below.
      } finally {
        clearInterval(watchdog);
      }
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  };

  openMempool();
  void readHints();

  return () => {
    stopped = true;
    socket?.close();
    abort?.abort();
  };
}
