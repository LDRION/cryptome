import type { Asset, Chain } from '../chains.ts';

/**
 * What the radar reads to find new markets, all free and without keys: DefiLlama for each chain's
 * DEX volume and liquidity, Chainlist for public RPCs, GeckoTerminal for a chain's biggest pools,
 * from which a chain description for recon is built.
 */

export interface LlamaChain {
  name: string;
  chainId: number | null;
  tvl: number;
  gasTokenGeckoId: string | null;
}

export interface Market {
  /** DefiLlama's key for the chain in its DEX volume breakdown. */
  slug: string;
  name: string;
  chainId: number;
  volume24hUsd: number;
  tvlUsd: number;
  gasTokenGeckoId: string | null;
}

export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Volume keys that are not a chain name in DefiLlama's chain list. */
const SLUG_ALIASES: Record<string, string> = { avax: 'avalanche', hyperliquid: 'hyperliquidl1', polygon: 'polygon', xdai: 'gnosis', era: 'zksyncera', op: 'opmainnet', optimism: 'opmainnet' };

/** Each chain's DEX volume over the last day, summed over every DEX DefiLlama lists, by its chain key. */
export function volumesBySlug(protocols: readonly { breakdown24h?: Record<string, Record<string, number>> | null }[]): Map<string, number> {
  const volumes = new Map<string, number>();
  for (const protocol of protocols) {
    for (const [slug, dexes] of Object.entries(protocol.breakdown24h ?? {})) {
      const usd = Object.values(dexes ?? {}).reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
      volumes.set(slug, (volumes.get(slug) ?? 0) + usd);
    }
  }
  return volumes;
}

/** The chain a volume key stands for: an exact name, an alias, or a name that begins with the key. */
export function matchChain(slug: string, chains: readonly LlamaChain[]): LlamaChain | null {
  const key = norm(SLUG_ALIASES[slug] ?? slug);
  const exact = chains.find((chain) => norm(chain.name) === key);
  if (exact) return exact;
  if (key.length < 3) return null;
  return chains.find((chain) => norm(chain.name).startsWith(key)) ?? null;
}

/** EVM chains with their volume, biggest first. A chain without a chain id is not EVM, or not known well enough. */
export function marketsOf(volumes: ReadonlyMap<string, number>, chains: readonly LlamaChain[]): Market[] {
  const markets: Market[] = [];
  for (const [slug, volume24hUsd] of volumes) {
    const chain = matchChain(slug, chains);
    if (!chain?.chainId) continue;
    markets.push({ slug, name: chain.name, chainId: chain.chainId, volume24hUsd, tvlUsd: chain.tvl, gasTokenGeckoId: chain.gasTokenGeckoId });
  }
  return markets.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
}

/** Public RPCs that need no key, as listed in Chainlist. */
export function keylessRpcs(rpcs: readonly (string | { url?: string })[]): string[] {
  return rpcs
    .map((rpc) => (typeof rpc === 'string' ? rpc : (rpc.url ?? '')))
    .filter((url) => url.startsWith('https://') && !/\$\{|api[_-]?key|INFURA|ALCHEMY/i.test(url));
}

export interface GeckoPool {
  attributes: {
    base_token_price_usd?: string | null;
    quote_token_price_usd?: string | null;
    base_token_price_native_currency?: string | null;
    quote_token_price_native_currency?: string | null;
    reserve_in_usd?: string | null;
  };
  relationships: { base_token: { data: { id: string } }; quote_token: { data: { id: string } } };
}

export interface GeckoNetwork {
  id: string;
  attributes: { name: string };
}

const NETWORK_ALIASES: Record<string, string> = { bsc: 'bnbchain', polygon: 'polygonpos', avax: 'avalanche' };

/** GeckoTerminal's network for a market, by its name or key. */
export function matchNetwork(market: Pick<Market, 'slug' | 'name'>, networks: readonly GeckoNetwork[]): string | null {
  const wanted = [norm(NETWORK_ALIASES[market.slug] ?? market.slug), norm(market.name)];
  const exact = networks.find((network) => wanted.includes(norm(network.attributes.name)) || wanted.includes(norm(network.id)));
  if (exact) return exact.id;
  return networks.find((network) => wanted.some((w) => w.length >= 4 && norm(network.attributes.name).startsWith(w)))?.id ?? null;
}

/** "base_0xabc" and "polygon_pos_0xabc" alike carry the address after the last underscore. */
const addressOf = (tokenId: string): string => tokenId.slice(tokenId.lastIndexOf('_') + 1).toLowerCase();

const near = (price: number, target: number, tolerance: number): boolean => target > 0 && Math.abs(price / target - 1) <= tolerance;

/**
 * The tokens recon can price on a chain, read from its biggest pools: dollar coins, bridged ETH and BTC,
 * and the wrapped native coin, which is the token a pool prices at exactly one native coin. A trade in
 * any other token counts as $0 there, so this undercounts rather than overcounts.
 */
export function tokensOf(pools: readonly GeckoPool[], prices: { ethUsd: number; btcUsd: number }, nativeIsEth: boolean): { wrappedNative: string | null; tokens: Record<string, Asset> } {
  const tokens: Record<string, Asset> = {};
  const nativeVotes = new Map<string, number>();
  for (const pool of pools) {
    const sides = [
      { id: pool.relationships.base_token.data.id, usd: Number(pool.attributes.base_token_price_usd), native: Number(pool.attributes.base_token_price_native_currency) },
      { id: pool.relationships.quote_token.data.id, usd: Number(pool.attributes.quote_token_price_usd), native: Number(pool.attributes.quote_token_price_native_currency) },
    ];
    for (const side of sides) {
      const address = addressOf(side.id);
      if (!/^0x[0-9a-f]{40}$/.test(address) || !Number.isFinite(side.usd)) continue;
      if (near(side.native, 1, 0.001)) nativeVotes.set(address, (nativeVotes.get(address) ?? 0) + 1);
      if (near(side.usd, 1, 0.01)) tokens[address] = 'USD';
      else if (near(side.usd, prices.ethUsd, 0.02)) tokens[address] = 'ETH';
      else if (near(side.usd, prices.btcUsd, 0.02)) tokens[address] = 'BTC';
    }
  }
  const wrappedNative = [...nativeVotes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (wrappedNative) tokens[wrappedNative] = nativeIsEth ? 'ETH' : 'NATIVE';
  return { wrappedNative, tokens };
}

/** What recon needs to measure a chain it has no entry for. */
export function chainFor(market: Market, rpc: string, priced: { wrappedNative: string; tokens: Record<string, Asset> }): Chain {
  const nativeIsEth = market.gasTokenGeckoId === 'ethereum';
  return {
    name: market.slug,
    defaultRpc: rpc,
    wrappedNative: priced.wrappedNative,
    nativeAsset: nativeIsEth ? 'ETH' : 'NATIVE',
    ...(!nativeIsEth && market.gasTokenGeckoId ? { coingeckoId: market.gasTokenGeckoId } : {}),
    tokens: priced.tokens,
  };
}
