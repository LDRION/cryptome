import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createRpc } from '../src/rpc.ts';

test('a node that accepts a call and never answers cannot hold it up past its limit', async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const started = Date.now();
  await assert.rejects(createRpc(`http://127.0.0.1:${port}/secret-key`, 0, 50).call('eth_blockNumber', []), (err: Error) => err.message.includes('eth_blockNumber') && !err.message.includes('secret-key'));
  assert.ok(Date.now() - started < 2000, 'it gave up long before the operating system would have');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
