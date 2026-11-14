import { PRICE_FEEDS } from './chains.ts';
import { createRpc, type Rpc } from './rpc.ts';

const LATEST_ANSWER = '0x50d25bcd';

export type MajorPrices = { ETH: number; BTC: number };

/** Current price of a native coin with no on-chain feed. Good enough to rank chains. */
export async function spotUsd(coingeckoId: string): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`, { signal: AbortSignal.timeout(15_000) });
      const price = ((await res.json()) as Record<string, { usd?: number }>)[coingeckoId]?.usd;
      if (price) return price;
    } catch {
      // Retried below.
    }
    await new Promise((resolve) => setTimeout(resolve, 3000 * 2 ** attempt));
  }
  throw new Error(`No spot price for ${coingeckoId}`);
}

/** Reads historical ETH and BTC prices from the Base feeds, mapping time to a block. */
export async function createPriceReader(wrap: (rpc: Rpc) => Rpc = (rpc) => rpc, patience: { retries?: number; timeoutMs?: number } = {}): Promise<(timestamp: number) => Promise<MajorPrices>> {
  const rpc = wrap(createRpc(process.env.RPC_URL_BASE ?? process.env.RPC_URL ?? PRICE_FEEDS.rpc, patience.retries, patience.timeoutMs));
  const head = await rpc.call<{ number: string; timestamp: string }>('eth_getBlockByNumber', ['latest', false]);
  const headNumber = Number(BigInt(head.number));
  const headTimestamp = Number(BigInt(head.timestamp));

  return async (timestamp) => {
    const block = headNumber - Math.floor((headTimestamp - timestamp) / PRICE_FEEDS.blockTimeSeconds);
    const tag = `0x${block.toString(16)}`;
    const read = async (feed: string): Promise<number> =>
      Number(BigInt(await rpc.call<string>('eth_call', [{ to: feed, data: LATEST_ANSWER }, tag]))) / 1e8;
    const [ETH, BTC] = await Promise.all([read(PRICE_FEEDS.ETH), read(PRICE_FEEDS.BTC)]);
    return { ETH, BTC };
  };
}
