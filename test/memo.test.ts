import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Archive, archiveDir, lastCompleteBlock, type Chunk } from '../src/paper/archive.ts';
import { Memo, memoizedRpc } from '../src/paper/memo.ts';
import type { PoolLog } from '../src/paper/pools.ts';
import type { Rpc } from '../src/rpc.ts';

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'cryptome-'));

test('a remembered answer survives a restart and is not computed again', async () => {
  const dir = await tempDir();
  const file = join(dir, 'memo.jsonl');
  let computed = 0;
  const compute = async (): Promise<number> => ++computed;

  const first = await Memo.open(file);
  assert.equal(await first.get('a', compute), 1);
  assert.equal(await first.get('a', compute), 1);

  const second = await Memo.open(file);
  assert.equal(await second.get('a', compute), 1);
  assert.equal(computed, 1);
  await rm(dir, { recursive: true, maxRetries: 5 });
});

test('a memo that does not exist yet starts empty, and any other read failure is an error', async () => {
  const dir = await tempDir();
  assert.equal((await Memo.open(join(dir, 'new.jsonl'))).size, 0);
  // A folder cannot be read as a file. Treating that as empty would silently repeat every request.
  await assert.rejects(Memo.open(dir));
  await rm(dir, { recursive: true, maxRetries: 5 });
});

test('asking twice at once does the work once', async () => {
  const dir = await tempDir();
  const memo = await Memo.open(join(dir, 'memo.jsonl'));
  let computed = 0;
  const slow = async (): Promise<number> => {
    computed++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 7;
  };
  assert.deepEqual(await Promise.all([memo.get('k', slow), memo.get('k', slow)]), [7, 7]);
  assert.equal(computed, 1);
  await rm(dir, { recursive: true, maxRetries: 5 });
});

test('a line cut short by a crash does not lose the rest', async () => {
  const dir = await tempDir();
  const file = join(dir, 'memo.jsonl');
  await writeFile(file, '["a",1]\n["b",\n["c",3]\n');
  const memo = await Memo.open(file);
  assert.equal(memo.size, 2);
  assert.equal(await memo.get('c', async () => 0), 3);
  await rm(dir, { recursive: true, maxRetries: 5 });
});

test('a failed computation is not remembered', async () => {
  const dir = await tempDir();
  const memo = await Memo.open(join(dir, 'memo.jsonl'));
  await assert.rejects(memo.get('k', async () => { throw new Error('network'); }));
  assert.equal(await memo.get('k', async () => 5), 5);
  await rm(dir, { recursive: true, maxRetries: 5 });
});

const countingRpc = (answer: (params: unknown[]) => unknown): Rpc & { calls: () => number } => {
  let calls = 0;
  return {
    calls: () => calls,
    async call<T>(_method: string, params: unknown[]): Promise<T> {
      calls++;
      return answer(params) as T;
    },
  };
};

test('calls pinned to a block are remembered, and calls about the present never are', async () => {
  const dir = await tempDir();
  const memo = await Memo.open(join(dir, 'memo.jsonl'));
  const inner = countingRpc(() => '0x1');
  const rpc = memoizedRpc(inner, memo);
  await rpc.call('eth_call', [{ to: '0xa' }, '0x10']);
  await rpc.call('eth_call', [{ to: '0xa' }, '0x10']);
  assert.equal(inner.calls(), 1);
  await rpc.call('eth_call', [{ to: '0xa' }, '0x11']);
  assert.equal(inner.calls(), 2, 'another block is another question');
  await rpc.call('eth_call', [{ to: '0xa' }, 'latest']);
  await rpc.call('eth_call', [{ to: '0xa' }, 'latest']);
  assert.equal(inner.calls(), 4);
  await rm(dir, { recursive: true, maxRetries: 5 });
});

test('a revert is remembered as a revert, but a network failure is not remembered at all', async () => {
  const dir = await tempDir();
  const memo = await Memo.open(join(dir, 'memo.jsonl'));
  let mode: 'revert' | 'network' = 'revert';
  const inner = countingRpc(() => {
    throw new Error(mode === 'revert' ? 'eth_call: execution reverted' : 'HTTP 500');
  });
  const rpc = memoizedRpc(inner, memo);
  await assert.rejects(rpc.call('eth_call', [{ to: '0xa' }, '0x10']), /execution reverted/);
  await assert.rejects(rpc.call('eth_call', [{ to: '0xa' }, '0x10']), /execution reverted/);
  assert.equal(inner.calls(), 1);

  mode = 'network';
  await assert.rejects(rpc.call('eth_call', [{ to: '0xb' }, '0x10']), /HTTP 500/);
  await assert.rejects(rpc.call('eth_call', [{ to: '0xb' }, '0x10']), /HTTP 500/);
  assert.equal(inner.calls(), 3);
  await rm(dir, { recursive: true, maxRetries: 5 });
});

const hex = (n: number): string => `0x${n.toString(16)}`;
const log = (block: number, index: number): PoolLog => ({ address: '0xa', topics: [], data: '0x', transactionHash: `0x${block}${index}`, logIndex: hex(index), blockNumber: hex(block) });

const fakeChunk = async (from: number, to: number): Promise<Chunk> => {
  const headers = [];
  const logs: PoolLog[] = [];
  for (let block = from; block <= to; block++) {
    headers.push({ number: hex(block) });
    if (block % 2 === 0) logs.push(log(block, 0), log(block, 1));
  }
  return { headers, logs };
};

test('the archive fetches only the stretches that hold the requested blocks', async () => {
  const dir = await tempDir();
  let fetches = 0;
  const archive = new Archive(dir, (from, to) => {
    fetches++;
    return fakeChunk(from, to);
  });
  await archive.ensure(150, 260, 2);
  assert.equal(fetches, 2, 'the chunks starting at 100 and 200');
  await rm(dir, { recursive: true, maxRetries: 5 });
});

test('the archive resumes without fetching again and reads blocks across chunks', async () => {
  const dir = await tempDir();
  let fetches = 0;
  const archive = new Archive(dir, (from, to) => {
    fetches++;
    return fakeChunk(from, to);
  });
  await archive.ensure(198, 202, 2);
  assert.equal(fetches, 2);
  await archive.ensure(198, 202, 2);
  assert.equal(fetches, 2);

  const seen: [number, number][] = [];
  for await (const { header, logs } of archive.blocks(198, 202)) seen.push([Number(BigInt(header.number!)), logs.length]);
  assert.deepEqual(seen, [[198, 2], [199, 0], [200, 2], [201, 0], [202, 2]]);
  assert.ok((await readFile(join(dir, '100.json'), 'utf8')).includes('"headers"'));
  await rm(dir, { recursive: true, maxRetries: 5 });
});

test('a missing stretch of the archive is an error, not silent empty blocks', async () => {
  const dir = await tempDir();
  const archive = new Archive(dir, fakeChunk);
  await assert.rejects(async () => {
    for await (const _ of archive.blocks(100, 101)) continue;
  }, /missing/);
  await rm(dir, { recursive: true, maxRetries: 5 });
});

test('only complete, settled stretches of blocks are stored', () => {
  assert.equal(lastCompleteBlock(1000, 64), 899);
  assert.equal(lastCompleteBlock(1062, 64), 899);
  assert.equal(lastCompleteBlock(1063, 64), 999, 'block 999 is now 64 behind the head');
});

test('each set of pools keeps its own archive', () => {
  const a = archiveDir('root', 'ethereum', ['0x1', '0x2']);
  assert.equal(a, archiveDir('root', 'ethereum', ['0x2', '0x1']), 'order does not matter');
  assert.notEqual(a, archiveDir('root', 'ethereum', ['0x1', '0x3']));
});
