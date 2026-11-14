// How much arbitrage everyone took inside self-built blocks, and on which pools: the size of our niche.
// Reads public chain data only. A transaction counts as an arbitrage when it swapped on two pools or more,
// paid no ETH, ended short of no token, and took its profit from those pools alone: any other party may
// only receive, as a bot's treasury does. Checked on 2026-11-12 against our own win, which it finds.
// Usage: pnpm niche:pie data/proposers-<run>-real.jsonl
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

const [proposersFile] = process.argv.slice(2);
if (!proposersFile) throw new Error('give a proposers log, e.g. data/proposers-<run>-real.jsonl');
const hotAddress = process.env.SENDER_PRIVATE_KEY ? privateKeyToAccount(process.env.SENDER_PRIVATE_KEY).address : '0x0';
const spot = async (pair) => Number((await (await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`)).json()).data.amount);
const [ETH, BTC] = await Promise.all([spot('ETH-USD'), spot('BTC-USD')]);
const rpc = 'https://ethereum-rpc.publicnode.com';
const call = async (method, params, tries = 3) => {
  for (let i = 0; ; i++) {
    try {
      const res = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
      if (res.error) throw new Error(res.error.message);
      return res.result;
    } catch (err) {
      if (i + 1 >= tries) throw err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
};
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SWAPS = new Set([
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', // V2
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', // V3
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', // V4
  '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83', // V3 forks with protocol fees (Pancake)
  '0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b', // Balancer V2
  '0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140', // Curve TokenExchange
  '0xd013ca23e77a65003c2c659c5442c00c805371b7fc1ebd4c206c41d1536bd90b', // Curve TokenExchangeUnderlying
]);
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WETH_DEPOSIT = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WETH_WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const V4_POOL_MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90';
const PRICE = new Map([
  ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', [18, ETH]],
  ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', [6, 1]],
  ['0xdac17f958d2ee523a2206206994597c13d831ec7', [6, 1]],
  ['0x6b175474e89094c44da98e2954e2c6e8a1fd5c2f', [18, 1]],
  ['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', [8, BTC]],
  ['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', [8, BTC]],
  ['0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', [18, ETH * 1.21]],
]);
const universe = JSON.parse(readFileSync('data/universe-ethereum.json', 'utf8'));
const ours = new Set(universe.pools.map((p) => p.address.toLowerCase()));
const wide = new Set(JSON.parse(readFileSync('data/universe-ethereum-wide.json', 'utf8')).pools.map((p) => p.address.toLowerCase()));

const rows = readFileSync(proposersFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ownBlocks = rows.filter((r) => r.kind !== 'builder').map((r) => r.block);
console.log(`self-built blocks in ${proposersFile}: ${ownBlocks.length} of ${rows.length} watched`);

const arbs = [];
let done = 0;
const queue = [...ownBlocks];
const worker = async () => {
  while (queue.length) {
    const block = queue.shift();
    const tag = `0x${block.toString(16)}`;
    const [b, receipts] = await Promise.all([call('eth_getBlockByNumber', [tag, true]), call('eth_getBlockReceipts', [tag])]);
    const byHash = new Map(b.transactions.map((t) => [t.hash, t]));
    for (const r of receipts) {
      if (r.status !== '0x1') continue;
      const tx = byHash.get(r.transactionHash);
      if (!tx?.to) continue;
      const who = new Set([tx.from.toLowerCase(), tx.to.toLowerCase()]);
      const swapPools = new Set(r.logs.filter((l) => SWAPS.has(l.topics[0])).map((l) => l.address.toLowerCase()));
      if (swapPools.size < 2) continue;
      // Paying in ETH or in a token we cannot price is a user's swap, not an arbitrage.
      if (BigInt(tx.value) > 0n) continue;
      // Token transfers, plus ETH wrapped or unwrapped by the bot. Uniswap V4 pools trade bare ETH, which no
      // event shows, so a wrap or unwrap in a transaction that swapped on V4 is ETH to or from its PoolManager.
      const flows = [];
      const nativeParty = swapPools.has(V4_POOL_MANAGER) ? V4_POOL_MANAGER : 'native';
      for (const l of r.logs) {
        const amount = () => BigInt(l.data === '0x' ? '0x0' : l.data.slice(0, 66));
        if (l.topics[0] === TRANSFER && l.topics.length >= 3) flows.push({ token: l.address.toLowerCase(), from: `0x${l.topics[1].slice(26)}`, to: `0x${l.topics[2].slice(26)}`, amount: amount() });
        else if (l.address.toLowerCase() === WETH && l.topics[0] === WETH_DEPOSIT) flows.push({ token: WETH, from: nativeParty, to: `0x${l.topics[1].slice(26)}`, amount: amount() });
        else if (l.address.toLowerCase() === WETH && l.topics[0] === WETH_WITHDRAWAL) flows.push({ token: WETH, from: `0x${l.topics[1].slice(26)}`, to: nativeParty, amount: amount() });
      }
      const raw = new Map();
      for (const f of flows) {
        if (who.has(f.to)) raw.set(f.token, (raw.get(f.token) ?? 0n) + f.amount);
        if (who.has(f.from)) raw.set(f.token, (raw.get(f.token) ?? 0n) - f.amount);
      }
      if ([...raw.values()].some((v) => v < 0n)) continue;
      // Every party that is not a pool it swapped with must come out even, as a flash lender does. Money from
      // a lending market, a user or a settlement is a position or an order, not a gap taken from pools.
      const byParty = new Map();
      for (const f of flows) {
        if (who.has(f.to) && !who.has(f.from)) byParty.set(`${f.from}|${f.token}`, (byParty.get(`${f.from}|${f.token}`) ?? 0n) + f.amount);
        if (who.has(f.from) && !who.has(f.to)) byParty.set(`${f.to}|${f.token}`, (byParty.get(`${f.to}|${f.token}`) ?? 0n) - f.amount);
      }
      // A party outside the pools may only receive: that is where a bot keeps its profit, as our treasury does.
      if ([...byParty].some(([key, v]) => v > 0n && !swapPools.has(key.split('|')[0]))) continue;
      // The profit is what the pools gave up in known tokens.
      const delta = new Map();
      for (const [key, v] of byParty) {
        const [party, token] = key.split('|');
        if (!swapPools.has(party) || !PRICE.has(token.toLowerCase())) continue;
        const [dec, px] = PRICE.get(token.toLowerCase());
        delta.set(token, (delta.get(token) ?? 0) + (Number(v) / 10 ** dec) * px);
      }
      const values = [...delta.values()];
      const gross = values.reduce((a, b) => a + b, 0);
      if (values.length === 0 || values.some((v) => v < -0.01) || gross <= 0.01) continue;
      const fee = (Number(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)) / 1e18) * ETH;
      const pools = [...swapPools];
      arbs.push({ block, idx: parseInt(r.transactionIndex, 16), from: tx.from.toLowerCase(), to: tx.to.toLowerCase(), gross, fee, net: gross - fee, tipGwei: (Number(BigInt(r.effectiveGasPrice) - BigInt(b.baseFeePerGas)) / 1e9), pools, inOurs: pools.filter((p) => ours.has(p)).length, inWide: pools.filter((p) => wide.has(p)).length, gas: Number(BigInt(r.gasUsed)), ourTx: tx.from.toLowerCase() === hotAddress.toLowerCase() });
    }
    if (++done % 50 === 0) console.error(`  ${done} blocks`);
  }
};
await Promise.all(Array.from({ length: 4 }, worker));

const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const mine = arbs.filter((a) => a.ourTx);
const theirs = arbs.filter((a) => !a.ourTx);
console.log(`arbitrage txs found: ${arbs.length} (ours ${mine.length}); gross $${sum(arbs, (a) => a.gross).toFixed(2)}, after their gas $${sum(arbs, (a) => a.net).toFixed(2)}`);
console.log(`ours: gross $${sum(mine, (a) => a.gross).toFixed(2)}, net $${sum(mine, (a) => a.net).toFixed(2)}`);
const allOurs = theirs.filter((a) => a.inOurs === a.pools.length), someOurs = theirs.filter((a) => a.inOurs > 0 && a.inOurs < a.pools.length), wideOnly = theirs.filter((a) => a.inOurs === 0 && a.inWide > 0), none = theirs.filter((a) => a.inOurs === 0 && a.inWide === 0);
for (const [label, list] of [['all pools in our universe', allOurs], ['some pools in our universe', someOurs], ['only in the wide universe', wideOnly], ['pools we do not track at all', none]]) console.log(`  ${label.padEnd(30)} txs ${String(list.length).padStart(4)}, net $${sum(list, (a) => a.net).toFixed(2).padStart(8)}`);
const bySender = new Map();
for (const a of theirs) { const k = a.to; const e = bySender.get(k) ?? { n: 0, net: 0, tips: [] }; e.n++; e.net += a.net; e.tips.push(a.tipGwei); bySender.set(k, e); }
console.log('top contracts by net in self-built blocks:');
for (const [k, e] of [...bySender].sort((a, b) => b[1].net - a[1].net).slice(0, 8)) console.log(`  ${k.slice(0, 12)} txs ${String(e.n).padStart(3)} net $${e.net.toFixed(2).padStart(7)} median tip ${e.tips.sort((a, b) => a - b)[Math.floor(e.tips.length / 2)].toFixed(3)} gwei`);
console.log('largest single arbitrages:');
for (const a of theirs.sort((x, y) => y.net - x.net).slice(0, 8)) console.log(`  block ${a.block} idx ${a.idx} net $${a.net.toFixed(2)} gross $${a.gross.toFixed(2)} pools ${a.pools.length} (ours ${a.inOurs}, wide ${a.inWide}) tip ${a.tipGwei.toFixed(2)} gwei gas ${a.gas}`);
