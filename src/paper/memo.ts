import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Rpc } from '../rpc.ts';

/**
 * Remembers answers about the past on disk. A question about a fixed block always has the
 * same answer, so a replay only pays the network once, and trying another setting takes
 * seconds instead of half an hour.
 */
export class Memo {
  private readonly values = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly file: string;

  private constructor(file: string) {
    this.file = file;
  }

  static async open(file: string): Promise<Memo> {
    const memo = new Memo(file);
    await mkdir(dirname(file), { recursive: true });
    // Read line by line: this file outgrows the longest string Node can hold, and reading it
    // whole would fail in a way that looks like an empty memo and repeats every request.
    const input = createReadStream(file, 'utf8');
    try {
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        if (line === '') continue;
        // A line cut short by a crash is skipped and simply computed again.
        try {
          const [key, value] = JSON.parse(line) as [string, unknown];
          memo.values.set(key, value);
        } catch {
          continue;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return memo;
  }

  get size(): number {
    return this.values.size;
  }

  async get<T>(key: string, compute: () => Promise<T>): Promise<T> {
    if (this.values.has(key)) return this.values.get(key) as T;
    const running = this.inFlight.get(key);
    if (running) return (await running) as T;
    const work = compute().then(async (value) => {
      this.values.set(key, value);
      await appendFile(this.file, `${JSON.stringify([key, value])}\n`);
      return value;
    });
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

const BLOCK_TAG = /^0x[0-9a-f]+$/;
interface Remembered {
  ok?: unknown;
  reverted?: string;
}

/** Remembers calls pinned to a block number, including reverts, which never change either. */
export function memoizedRpc(rpc: Rpc, memo: Memo): Rpc {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const tag = params[1];
      if (method !== 'eth_call' || typeof tag !== 'string' || !BLOCK_TAG.test(tag)) return rpc.call<T>(method, params);
      const key = `call:${createHash('sha1').update(JSON.stringify(params)).digest('base64url')}`;
      const remembered = await memo.get<Remembered>(key, async () => {
        try {
          return { ok: await rpc.call<T>(method, params) };
        } catch (err) {
          const message = (err as Error).message;
          if (!message.includes('execution reverted')) throw err;
          return { reverted: message };
        }
      });
      if (remembered.reverted !== undefined) throw new Error(remembered.reverted);
      return remembered.ok as T;
    },
  };
}
