import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterPass, marketAlerts, measuredAlert, newState, RADAR, steadyNetPerDay, toMeasure, type RadarState } from '../src/radar/plan.ts';
import { chainFor, keylessRpcs, marketsOf, matchChain, matchNetwork, tokensOf, volumesBySlug, type GeckoPool, type LlamaChain, type Market } from '../src/radar/sources.ts';

const CHAINS: LlamaChain[] = [
  { name: 'Robinhood Chain', chainId: 4663, tvl: 9e8, gasTokenGeckoId: 'ethereum' },
  { name: 'Monad', chainId: 143, tvl: 3e8, gasTokenGeckoId: 'monad' },
  { name: 'Avalanche', chainId: 43114, tvl: 1e9, gasTokenGeckoId: 'avalanche-2' },
  { name: 'Solana', chainId: null, tvl: 9e9, gasTokenGeckoId: 'solana' },
  { name: 'Ethereum', chainId: 1, tvl: 6e10, gasTokenGeckoId: 'ethereum' },
];
const DAY = 86_400_000;
const market = (slug: string, volume24hUsd: number, extra: Partial<Market> = {}): Market => ({ slug, name: slug, chainId: 1, volume24hUsd, tvlUsd: 1e7, gasTokenGeckoId: 'ethereum', ...extra });

test('volume is summed per chain key and matched to chains by name, alias or prefix, EVM only', () => {
  const volumes = volumesBySlug([{ breakdown24h: { robinhood: { a: 5e8, b: 1e8 }, monad: { a: 7e7 } } }, { breakdown24h: { robinhood: { c: 1e8 }, solana: { d: 9e9 }, avax: { e: 3e6 } } }, { breakdown24h: null }]);
  assert.equal(volumes.get('robinhood'), 7e8);
  assert.equal(matchChain('robinhood', CHAINS)?.name, 'Robinhood Chain', 'a name that begins with the key');
  assert.equal(matchChain('avax', CHAINS)?.name, 'Avalanche', 'an alias');
  assert.equal(matchChain('zz', CHAINS), null, 'too short to guess');
  const markets = marketsOf(volumes, CHAINS);
  assert.deepEqual(markets.map((m) => m.slug), ['robinhood', 'monad', 'avax'], 'Solana has no chain id and is left out');
});

test('only public RPCs that need no key are used', () => {
  assert.deepEqual(keylessRpcs(['https://rpc.example', 'wss://ws.example', 'https://x.infura.io/v3/${INFURA_API_KEY}', { url: 'https://y.example' }, 'http://plain.example']), ['https://rpc.example', 'https://y.example']);
});

const pool = (base: string, quote: string, baseUsd: number, quoteUsd: number, baseNative: number, quoteNative: number): GeckoPool => ({
  attributes: { base_token_price_usd: String(baseUsd), quote_token_price_usd: String(quoteUsd), base_token_price_native_currency: String(baseNative), quote_token_price_native_currency: String(quoteNative) },
  relationships: { base_token: { data: { id: `net_${base}` } }, quote_token: { data: { id: `polygon_pos_${quote}` } } },
});
const WMON = '0x' + 'a'.repeat(40);
const USDC = '0x' + 'b'.repeat(40);
const WETH = '0x' + 'c'.repeat(40);
const MEME = '0x' + 'd'.repeat(40);

test('a chain is priced from its biggest pools: dollar coins, bridged ETH, and the token worth one native coin', () => {
  const pools = [pool(WMON, USDC, 0.04, 1.0005, 1, 25), pool(WETH, WMON, 3000, 0.04, 75000, 1), pool(MEME, WMON, 0.00001, 0.04, 0.00025, 1)];
  const priced = tokensOf(pools, { ethUsd: 3010, btcUsd: 100000 }, false);
  assert.equal(priced.wrappedNative, WMON);
  assert.deepEqual(priced.tokens, { [WMON]: 'NATIVE', [USDC]: 'USD', [WETH]: 'ETH' }, 'a meme coin is left unpriced, which undercounts rather than overcounts');
  const chain = chainFor(market('monad', 8e7, { gasTokenGeckoId: 'monad' }), 'https://rpc.monad.example', { wrappedNative: WMON, tokens: priced.tokens });
  assert.equal(chain.nativeAsset, 'NATIVE');
  assert.equal(chain.coingeckoId, 'monad');
  assert.equal(chainFor(market('robinhood', 7e8), 'https://r', { wrappedNative: WETH, tokens: {} }).nativeAsset, 'ETH', 'an ETH chain prices its native coin as ETH');
});

test('GeckoTerminal networks are found by name or key', () => {
  const networks = [{ id: 'robinhood', attributes: { name: 'Robinhood Chain' } }, { id: 'bsc', attributes: { name: 'BNB Chain' } }, { id: 'monad-mainnet', attributes: { name: 'Monad' } }];
  assert.equal(matchNetwork({ slug: 'monad', name: 'Monad' }, networks), 'monad-mainnet');
  assert.equal(matchNetwork({ slug: 'bsc', name: 'BSC' }, networks), 'bsc');
  assert.equal(matchNetwork({ slug: 'robinhood', name: 'Robinhood Chain' }, networks), 'robinhood');
  assert.equal(matchNetwork({ slug: 'nowhere', name: 'Nowhere' }, networks), null);
});

test('new markets are measured first, known ones weekly or when their volume doubles, and small or skipped ones never', () => {
  const now = 100 * DAY;
  const state: RadarState = {
    ...newState(0),
    markets: {
      monad: { firstSeenAt: 0, atStart: true, measured: { at: now - 2 * DAY, volume24hUsd: 3e7 } },
      xlayer: { firstSeenAt: 0, atStart: true, measured: { at: now - 2 * DAY, volume24hUsd: 5e7 } },
      ink: { firstSeenAt: 0, atStart: true, measured: { at: now - 8 * DAY, volume24hUsd: 6e6 } },
    },
  };
  const due = toMeasure([market('ethereum', 3e9), market('monad', 8e7), market('xlayer', 5e7), market('robinhood', 7e8), market('ink', 6e6), market('tiny', 1e6)], state, now);
  assert.deepEqual(due.map((m) => m.slug), ['robinhood', 'monad', 'ink'], 'never measured first; monad doubled; ink is a week old; xlayer is recent; ethereum skipped; tiny too small');
  assert.equal(due.length <= RADAR.MAX_MEASURES_PER_PASS, true);
});

test('news: a market that appears after the first pass, and one whose volume doubled in a week, each said once a week', () => {
  const t0 = 10 * DAY;
  let state = afterPass(newState(t0), [market('monad', 3e7)], new Map(), [], t0);
  assert.deepEqual(marketAlerts([market('monad', 3e7)], newState(t0), t0), [], 'nothing is news on the first pass');
  const t1 = t0 + 7 * DAY;
  const alerts = marketAlerts([market('monad', 8e7), market('arc', 2.3e7)], state, t1);
  assert.deepEqual(alerts.map((a) => [a.kind, a.slug]), [['growth', 'monad'], ['new-market', 'arc']]);
  state = afterPass(state, [market('monad', 8e7), market('arc', 2.3e7)], new Map(), alerts, t1);
  assert.deepEqual(marketAlerts([market('monad', 8e7), market('arc', 2.3e7)], state, t1 + DAY), [], 'not again the next day');
});

test('the money figure leaves out the two biggest hits, so one lucky trade cannot carry a market', () => {
  // OP Mainnet on 2026-11-07, in short: one $4.17 hit and one $2.60 hit out of $7.32 in 54 minutes.
  const op = { chainMinutes: 54, grossUsd: 7.32, botGasUsd: 2.09, pessimisticHiddenCostUsd: 2.6, hits: [{ usd: 4.17 }, { usd: 2.6 }, { usd: 0.11 }, { usd: null }, ...Array.from({ length: 50 }, () => ({ usd: 0.0088 }))] };
  assert.ok(steadyNetPerDay(op) < 0, 'nothing steady is left there');
  const steady = { chainMinutes: 60, grossUsd: 10, botGasUsd: 1, pessimisticHiddenCostUsd: 1, hits: Array.from({ length: 100 }, () => ({ usd: 0.1 })) };
  assert.equal(Math.round(steadyNetPerDay(steady)), Math.round(((10 - 0.2 - 2) * 1440) / 60), 'a market of many small hits keeps nearly all');
  assert.equal(steadyNetPerDay({ ...steady, chainMinutes: 0 }), 0);
});

test('a measurement speaks up only when bots clear real money after gas', () => {
  const m = market('monad', 8e7);
  assert.equal(measuredAlert(m, { at: 0, volume24hUsd: 8e7, netPerDayUsd: 12 }, undefined, 0), null);
  assert.equal(measuredAlert(m, { at: 0, volume24hUsd: 8e7, error: 'no rpc' }, undefined, 0), null);
  const alert = measuredAlert(m, { at: 0, volume24hUsd: 8e7, netPerDayUsd: 140, bots: 4, top1Share: 0.7 }, undefined, 0);
  assert.equal(alert?.kind, 'money');
  assert.match(alert!.text, /\$140.*ботов 4.*70%/);
});
