import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { spotUsd } from '../prices.ts';
import { afterPass, marketAlerts, measuredAlert, newState, RADAR, steadyNetPerDay, toMeasure, type Alert, type Measured, type RadarState, type ReconSummary } from './plan.ts';
import { chainFor, keylessRpcs, marketsOf, matchNetwork, tokensOf, volumesBySlug, type GeckoNetwork, type GeckoPool, type LlamaChain, type Market } from './sources.ts';

/**
 * The radar for new markets. Every six hours it reads which EVM chains carry real DEX volume, measures
 * the new and the fast-growing ones with recon on their own blocks (what bots make there, after gas,
 * and how many of them share it), and says so when a market is worth a closer look. It only reads.
 * Runs beside the sender in its own window; `--once` makes a single pass.
 */

const { values: args } = parseArgs({ options: { once: { type: 'boolean', default: false } } });

const DIR = 'data/radar';
const STATE = `${DIR}/state.json`;
const PASS_EVERY_MS = 6 * 3_600_000;
const RECON_TIMEOUT_MS = 40 * 60_000;
const RECON_ARGS = ['--days', '3', '--windows', '16', '--seconds', '20', '--concurrency', '3'];

const stamp = (): string => new Date().toLocaleString('ru-RU');
const say = (line: string): void => console.log(`${stamp()}  ${line}`);

async function json<T>(url: string, timeoutMs = 30_000): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
    }
  }
  throw new Error(`${new URL(url).host}: ${(last as Error).message}`);
}

const rpcCall = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error || body.result === undefined || body.result === null) throw new Error(body.error?.message ?? 'empty');
  return body.result;
};

/** The first public RPC that serves whole blocks of receipts, which recon reads. */
async function workingRpc(rpcs: readonly string[]): Promise<string | null> {
  for (const url of rpcs.slice(0, 8)) {
    try {
      const head = (await rpcCall(url, 'eth_blockNumber', [])) as string;
      await rpcCall(url, 'eth_getBlockReceipts', [`0x${(Number(BigInt(head)) - 2).toString(16)}`]);
      return url;
    } catch {
      // The next one.
    }
  }
  return null;
}

function runRecon(chainFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/recon.ts', '--chain-file', chainFile, ...RECON_ARGS], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err = (err + chunk.toString()).slice(-2000)));
    const timer = setTimeout(() => child.kill(), RECON_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const saved = /Saved (\S+\.json)/.exec(out)?.[1];
      if (code === 0 && saved) resolve(saved);
      else reject(new Error((err.trim().split('\n').at(-1) ?? `recon exited ${code}`).slice(0, 200)));
    });
  });
}

interface PassData {
  chainlist: { chainId: number; rpc?: (string | { url?: string })[] }[] | null;
  networks: GeckoNetwork[] | null;
  prices: { ethUsd: number; btcUsd: number } | null;
}

async function measure(market: Market, data: PassData): Promise<Measured> {
  const base = { at: Date.now(), volume24hUsd: market.volume24hUsd };
  const entry = data.chainlist?.find((chain) => chain.chainId === market.chainId);
  const rpc = await workingRpc(keylessRpcs(entry?.rpc ?? []));
  if (!rpc) return { ...base, error: 'нет публичного RPC с квитанциями блоков' };
  const network = data.networks ? matchNetwork(market, data.networks) : null;
  if (!network) return { ...base, error: 'нет данных о пулах' };
  if (!data.prices) return { ...base, error: 'нет цен ETH и BTC' };
  const pools: GeckoPool[] = [];
  for (const page of [1, 2]) pools.push(...(await json<{ data: GeckoPool[] }>(`https://api.geckoterminal.com/api/v2/networks/${network}/pools?page=${page}`)).data);
  const priced = tokensOf(pools, data.prices, market.gasTokenGeckoId === 'ethereum');
  if (!priced.wrappedNative || Object.keys(priced.tokens).length < 2) return { ...base, error: 'не удалось определить токены для оценки' };
  const chainFile = `${DIR}/chains/${market.slug}.json`;
  await mkdir(`${DIR}/chains`, { recursive: true });
  await writeFile(chainFile, JSON.stringify(chainFor(market, rpc, { wrappedNative: priced.wrappedNative, tokens: priced.tokens }), null, 2));
  const summary = JSON.parse(readFileSync(await runRecon(chainFile), 'utf8')) as ReconSummary & {
    failedBlocks: number;
    arb: { count: number };
    liquidation: { count: number };
    perDay: { grossUsd: number; pessimisticNetUsd: number };
    concentration: { contracts: number; top1: number };
  };
  return { ...base, netPerDayUsd: steadyNetPerDay(summary), rawNetPerDayUsd: summary.perDay.pessimisticNetUsd, grossPerDayUsd: summary.perDay.grossUsd, arbs: summary.arb.count, liquidations: summary.liquidation.count, bots: summary.concentration.contracts, top1Share: summary.concentration.top1, minutes: summary.chainMinutes, failedBlocks: summary.failedBlocks };
}

/** A Windows notification, so a find is seen even with the window hidden. */
function notify(text: string): void {
  if (process.platform !== 'win32') return;
  const script = "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle = 'Радар cryptome'; $n.BalloonTipText = $env:RADAR_TEXT; $n.Visible = $true; $n.ShowBalloonTip(20000); Start-Sleep -Seconds 21; $n.Dispose()";
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { env: { ...process.env, RADAR_TEXT: text.slice(0, 250) }, detached: true, stdio: 'ignore' }).unref();
}

async function pass(): Promise<void> {
  const now = Date.now();
  const state: RadarState = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as RadarState) : newState(now);
  const [chains, overview] = await Promise.all([
    json<LlamaChain[]>('https://api.llama.fi/v2/chains'),
    json<{ protocols: { breakdown24h?: Record<string, Record<string, number>> | null }[] }>('https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true', 60_000),
  ]);
  const markets = marketsOf(volumesBySlug(overview.protocols), chains);
  const alerts: Alert[] = marketAlerts(markets, state, now);
  const due = toMeasure(markets, state, now);

  const measured = new Map<string, Measured>();
  if (due.length > 0) {
    const networks: GeckoNetwork[] = [];
    for (let page = 1; page <= 4; page++) {
      const answer = await json<{ data: GeckoNetwork[]; links?: { next?: string | null } }>(`https://api.geckoterminal.com/api/v2/networks?page=${page}`).catch(() => null);
      if (!answer) break;
      networks.push(...answer.data);
      if (!answer.links?.next) break;
    }
    const data: PassData = {
      chainlist: await json<PassData['chainlist']>('https://chainid.network/chains.json', 60_000).catch(() => null),
      networks: networks.length > 0 ? networks : null,
      prices: await Promise.all([spotUsd('ethereum'), spotUsd('bitcoin')]).then(([ethUsd, btcUsd]) => ({ ethUsd, btcUsd })).catch(() => null),
    };
    for (const market of due) {
      say(`меряю ${market.name}: объём бирж $${(market.volume24hUsd / 1e6).toFixed(1)}M за сутки`);
      const result: Measured = await measure(market, data).catch((err: Error) => ({ at: Date.now(), volume24hUsd: market.volume24hUsd, error: err.message.slice(0, 200) }));
      measured.set(market.slug, result);
      say(result.error ? `  ${market.name}: не замерено, ${result.error}` : `  ${market.name}: ботов ${result.bots}, арбитражей ${result.arbs}, ликвидаций ${result.liquidations}, у ботов после газа около $${result.netPerDayUsd?.toFixed(2)} в сутки без двух лучших сделок ($${result.rawNetPerDayUsd?.toFixed(2)} со всеми)`);
      const money = measuredAlert(market, result, state.markets[market.slug], Date.now());
      if (money) alerts.push(money);
    }
  }

  const next = afterPass(state, markets, measured, alerts, now);
  await mkdir(DIR, { recursive: true });
  await writeFile(STATE, JSON.stringify(next, null, 2));
  await writeFile(`${DIR}/last-pass.json`, JSON.stringify({ at: new Date(now).toISOString(), markets: markets.slice(0, 30), measured: Object.fromEntries(measured), alerts }, null, 2));
  for (const alert of alerts) {
    await appendFile(`${DIR}/alerts.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), ...alert })}\n`);
    say(`НАХОДКА: ${alert.text}`);
    notify(alert.text);
  }
  const shown = markets.filter((market) => market.volume24hUsd >= RADAR.MIN_VOLUME_USD).slice(0, 12);
  say(`проход готов: рынков с объёмом от $${RADAR.MIN_VOLUME_USD / 1e6}M ${markets.filter((m) => m.volume24hUsd >= RADAR.MIN_VOLUME_USD).length}, замерено ${measured.size}, находок ${alerts.length}`);
  say(`  крупнейшие: ${shown.map((market) => `${market.name} $${(market.volume24hUsd / 1e6).toFixed(0)}M`).join(', ')}`);
}

say('радар новых рынков запущен, только читает, ничего не отправляет');
for (;;) {
  try {
    await pass();
  } catch (err) {
    // A failed pass is tried again on the next one; the radar itself keeps going.
    say(`проход не удался: ${(err as Error).message}`);
  }
  if (args.once) break;
  say(`следующий проход через ${PASS_EVERY_MS / 3_600_000} ч`);
  await new Promise((resolve) => setTimeout(resolve, PASS_EVERY_MS));
}
process.exit(0);
