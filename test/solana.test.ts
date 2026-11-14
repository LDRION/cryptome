import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSolanaArb, WRAPPED_SOL, type SolanaTx, type TokenBalance } from '../src/solana.ts';

const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BOT = 'botBotBot';

const balance = (accountIndex: number, mint: string, owner: string, amount: bigint, decimals = 9): TokenBalance => ({ accountIndex, mint, owner, uiTokenAmount: { amount: amount.toString(), decimals } });

/** Three pool accounts move, which is what a two-pool round trip looks like. */
const poolMoves = (): { pre: TokenBalance[]; post: TokenBalance[] } => ({
  pre: [balance(5, WRAPPED_SOL, 'pool1', 1000n), balance(6, BONK, 'pool1', 1000n), balance(7, BONK, 'pool2', 1000n), balance(8, WRAPPED_SOL, 'pool2', 1000n)],
  post: [balance(5, WRAPPED_SOL, 'pool1', 1100n), balance(6, BONK, 'pool1', 900n), balance(7, BONK, 'pool2', 1100n), balance(8, WRAPPED_SOL, 'pool2', 890n)],
});

const makeTx = (overrides: Partial<SolanaTx> = {}): SolanaTx => {
  const { pre, post } = poolMoves();
  return {
    signer: BOT,
    accountKeys: [BOT, TIP],
    fee: 15_000,
    signatures: 1,
    failed: false,
    preBalances: [10_000_000_000, 1_000_000],
    postBalances: [10_000_000_000, 1_000_000],
    preTokenBalances: [...pre, balance(10, WRAPPED_SOL, BOT, 1_000_000_000n)],
    postTokenBalances: [...post, balance(10, WRAPPED_SOL, BOT, 1_050_000_000n)],
    programs: new Set([RAYDIUM, ORCA]),
    ...overrides,
  };
};

test('a round trip that ends with more wrapped SOL is arbitrage', () => {
  const hit = detectSolanaArb(makeTx({ postBalances: [10_000_000_000 - 15_000, 1_000_000] }));
  assert.equal(hit?.gainAsset, 'SOL');
  assert.ok(Math.abs(hit!.gain - 0.05) < 1e-9);
  assert.equal(hit!.priorityLamports, 10_000);
});

test('native and wrapped SOL count as one asset, and the tip is not lost from gross', () => {
  const tip = 20_000_000;
  const hit = detectSolanaArb(makeTx({ postBalances: [10_000_000_000 - 15_000 - tip, 1_000_000 + tip] }));
  assert.equal(hit?.tipLamports, tip);
  assert.ok(Math.abs(hit!.gain - 0.05) < 1e-9, 'gross comes before the tip');
});

test('profit in a stablecoin keeps its own asset', () => {
  const { pre, post } = poolMoves();
  const hit = detectSolanaArb(
    makeTx({
      preTokenBalances: [...pre, balance(10, USDC, BOT, 5_000_000n, 6)],
      postTokenBalances: [...post, balance(10, USDC, BOT, 7_500_000n, 6)],
      postBalances: [10_000_000_000 - 15_000, 1_000_000],
    }),
  );
  assert.equal(hit?.gainAsset, USDC);
  assert.equal(hit?.gain, 2.5);
});

test('buying a token is not arbitrage, because something else went down', () => {
  const { pre, post } = poolMoves();
  const hit = detectSolanaArb(
    makeTx({
      preTokenBalances: [...pre, balance(10, WRAPPED_SOL, BOT, 1_000_000_000n), balance(11, BONK, BOT, 0n)],
      postTokenBalances: [...post, balance(10, WRAPPED_SOL, BOT, 500_000_000n), balance(11, BONK, BOT, 999n)],
    }),
  );
  assert.equal(hit, null);
});

test('gaining two assets at once is not a clean round trip', () => {
  const { pre, post } = poolMoves();
  const hit = detectSolanaArb(
    makeTx({
      preTokenBalances: [...pre, balance(10, WRAPPED_SOL, BOT, 1_000_000_000n), balance(11, BONK, BOT, 0n)],
      postTokenBalances: [...post, balance(10, WRAPPED_SOL, BOT, 1_050_000_000n), balance(11, BONK, BOT, 999n)],
    }),
  );
  assert.equal(hit, null);
});

test('a vault funding the trade makes it a one-way sale, not arbitrage', () => {
  const { pre, post } = poolMoves();
  const hit = detectSolanaArb(
    makeTx({
      preTokenBalances: [...pre, balance(9, BONK, 'vault', 5000n), balance(10, WRAPPED_SOL, BOT, 1_000_000_000n)],
      postTokenBalances: [...post, balance(9, BONK, 'vault', 1000n), balance(10, WRAPPED_SOL, BOT, 2_000_000_000n)],
    }),
  );
  assert.equal(hit, null);
});

test('a fee collector that only gains does not disqualify a real round trip', () => {
  const { pre, post } = poolMoves();
  const hit = detectSolanaArb(
    makeTx({
      preTokenBalances: [...pre, balance(9, WRAPPED_SOL, 'feeCollector', 100n), balance(10, WRAPPED_SOL, BOT, 1_000_000_000n)],
      postTokenBalances: [...post, balance(9, WRAPPED_SOL, 'feeCollector', 110n), balance(10, WRAPPED_SOL, BOT, 1_050_000_000n)],
      postBalances: [10_000_000_000 - 15_000, 1_000_000],
    }),
  );
  assert.equal(hit?.gainAsset, 'SOL');
});

test('a failed transaction is never a win', () => {
  assert.equal(detectSolanaArb(makeTx({ failed: true })), null);
});

test('a gain without any known pool program is not counted', () => {
  assert.equal(detectSolanaArb(makeTx({ programs: new Set(['SomeAirdropProgram']) })), null);
});

test('a single swap touching too few pool accounts is not a route', () => {
  assert.equal(
    detectSolanaArb(
      makeTx({
        preTokenBalances: [balance(5, WRAPPED_SOL, 'pool1', 1000n), balance(10, WRAPPED_SOL, BOT, 100n)],
        postTokenBalances: [balance(5, WRAPPED_SOL, 'pool1', 900n), balance(10, WRAPPED_SOL, BOT, 200n)],
      }),
    ),
    null,
  );
});
