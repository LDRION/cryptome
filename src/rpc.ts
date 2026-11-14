export interface Rpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

/** Waiting on a hung connection has no natural end, so every call has a limit. */
const DEFAULT_TIMEOUT_MS = 60_000;

export function createRpc(url: string, maxRetries = 6, timeoutMs = DEFAULT_TIMEOUT_MS): Rpc {
  let id = 0;
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
          const body = (await res.json()) as { result?: T; error?: { message: string } };
          if (body.error) throw new Error(`${method}: ${body.error.message}`);
          // Load-balanced public nodes answer null when the node picked has pruned the data.
          if (body.result === null || body.result === undefined) throw new Error(`${method}: empty result`);
          return body.result;
        } catch (err) {
          // A revert is the answer rather than a failure: asking again gives the same one.
          if (attempt >= maxRetries || (err as Error).message.includes('execution reverted')) {
            // Says which call and node gave up, without the path, which may hold a key.
            if ((err as Error).name === 'TimeoutError') throw new Error(`${method} at ${new URL(url).host}: no answer in ${timeoutMs} ms`);
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    },
  };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}
