import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mapLimit } from '../rpc.ts';
import type { PoolLog } from './pools.ts';

/** Headers and universe logs for one run of blocks, stored together so a replay needs no network. */
export interface Chunk {
  headers: Record<string, string>[];
  logs: PoolLog[];
}

export const CHUNK_BLOCKS = 100;

const chunkStart = (block: number): number => Math.floor(block / CHUNK_BLOCKS) * CHUNK_BLOCKS;

/** Different pools mean different stored logs, so each universe keeps its own folder. */
export function archiveDir(root: string, chain: string, pools: string[]): string {
  const id = createHash('sha1').update([...pools].sort().join()).digest('hex').slice(0, 10);
  return join(root, `${chain}-${id}`);
}

/** The last block of the newest chunk that is complete and settled at this head. */
export function lastCompleteBlock(head: number, settledBlocks: number): number {
  return chunkStart(head - settledBlocks + 1) - 1;
}

export type ChunkFetcher = (from: number, to: number) => Promise<Chunk>;

export class Archive {
  private readonly dir: string;
  private readonly fetch: ChunkFetcher;

  constructor(dir: string, fetch: ChunkFetcher) {
    this.dir = dir;
    this.fetch = fetch;
  }

  private path(start: number): string {
    return join(this.dir, `${start}.json`);
  }

  private async load(start: number): Promise<Chunk | null> {
    const text = await readFile(this.path(start), 'utf8').catch(() => null);
    return text === null ? null : (JSON.parse(text) as Chunk);
  }

  /** Downloads what is missing. Written whole, so an interrupted run resumes where it stopped. */
  async ensure(from: number, to: number, concurrency: number, progress?: (done: number, total: number) => void): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const starts: number[] = [];
    for (let start = chunkStart(from); start <= to; start += CHUNK_BLOCKS) starts.push(start);
    let done = 0;
    await mapLimit(starts, concurrency, async (start) => {
      const known = await readFile(this.path(start), 'utf8').then(() => true).catch(() => false);
      if (!known) {
        const chunk = await this.fetch(start, start + CHUNK_BLOCKS - 1);
        const partial = `${this.path(start)}.part`;
        await writeFile(partial, JSON.stringify(chunk));
        await rename(partial, this.path(start));
      }
      progress?.(++done, starts.length);
    });
  }

  /** Yields each block in order with its own logs. */
  async *blocks(from: number, to: number): AsyncGenerator<{ header: Record<string, string>; logs: PoolLog[] }> {
    for (let start = chunkStart(from); start <= to; start += CHUNK_BLOCKS) {
      const chunk = await this.load(start);
      if (!chunk) throw new Error(`Archive is missing blocks from ${start}`);
      const byBlock = new Map<number, PoolLog[]>();
      for (const log of chunk.logs) {
        const number = Number(BigInt(log.blockNumber!));
        const list = byBlock.get(number);
        if (list) list.push(log);
        else byBlock.set(number, [log]);
      }
      const headers = [...chunk.headers].sort((a, b) => Number(BigInt(a.number!) - BigInt(b.number!)));
      for (const header of headers) {
        const number = Number(BigInt(header.number!));
        if (number < from || number > to) continue;
        yield { header, logs: byBlock.get(number) ?? [] };
      }
    }
  }
}
