/**
 * Recognises atomic arbitrage in a Solana transaction from balance changes alone: the signer
 * ends with more of one asset and no less of any other, after trading through several pools.
 * Tips to Jito are visible as plain balance changes, so what stays with the bot is exact.
 */

export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1e9;

export const JITO_TIP_ACCOUNTS: ReadonlySet<string> = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

/** Pool programs. A transaction through at least two pool accounts of these is a real route. */
export const SWAP_PROGRAMS: ReadonlySet<string> = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe',
  'ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY',
  'obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
]);

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface SolanaTx {
  signer: string;
  accountKeys: string[];
  fee: number;
  signatures: number;
  failed: boolean;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  /** Programs called anywhere in the transaction, including inner calls. */
  programs: Set<string>;
}

export interface ArbHit {
  signer: string;
  /** The asset gained: 'SOL' for native and wrapped together, otherwise its mint. */
  gainAsset: string;
  gain: number;
  tipLamports: number;
  priorityLamports: number;
  pools: number;
}

const netOfOwner = (tx: SolanaTx, owner: string): Map<string, { amount: bigint; decimals: number }> => {
  const net = new Map<string, { amount: bigint; decimals: number }>();
  const add = (entry: TokenBalance, sign: bigint): void => {
    if (entry.owner !== owner) return;
    const known = net.get(entry.mint) ?? { amount: 0n, decimals: entry.uiTokenAmount.decimals };
    known.amount += sign * BigInt(entry.uiTokenAmount.amount);
    net.set(entry.mint, known);
  };
  for (const entry of tx.postTokenBalances) add(entry, 1n);
  for (const entry of tx.preTokenBalances) add(entry, -1n);
  return net;
};

/** Token accounts belonging to someone else that moved, which here means pools. */
function poolsTouched(tx: SolanaTx): number {
  const moved = new Set<number>();
  const pre = new Map(tx.preTokenBalances.map((entry) => [entry.accountIndex, entry]));
  for (const entry of tx.postTokenBalances) {
    if (entry.owner === tx.signer) continue;
    if (pre.get(entry.accountIndex)?.uiTokenAmount.amount !== entry.uiTokenAmount.amount) moved.add(entry.accountIndex);
  }
  return moved.size;
}

/**
 * A pool always gives one token and takes another. An owner that only loses is funding the
 * trade from outside, such as a bot's own vault selling, which looks like free profit to the
 * signer but is just a one-way sale.
 */
function someoneOnlyLost(tx: SolanaTx): boolean {
  const pre = new Map(tx.preTokenBalances.map((entry) => [entry.accountIndex, entry]));
  const post = new Map(tx.postTokenBalances.map((entry) => [entry.accountIndex, entry]));
  const moves = new Map<string, { gained: boolean; lost: boolean }>();
  for (const index of new Set([...pre.keys(), ...post.keys()])) {
    const owner = post.get(index)?.owner ?? pre.get(index)?.owner;
    if (!owner || owner === tx.signer) continue;
    const change = BigInt(post.get(index)?.uiTokenAmount.amount ?? 0) - BigInt(pre.get(index)?.uiTokenAmount.amount ?? 0);
    if (change === 0n) continue;
    const known = moves.get(owner) ?? { gained: false, lost: false };
    if (change > 0n) known.gained = true;
    else known.lost = true;
    moves.set(owner, known);
  }
  return [...moves.values()].some((move) => move.lost && !move.gained);
}

const MIN_POOL_ACCOUNTS = 3;
/** A round trip usually leaves crumbs behind, which should not hide a real profit. */
const DUST_SHARE = 0.0001;

export function detectSolanaArb(tx: SolanaTx): ArbHit | null {
  if (tx.failed) return null;
  if (![...tx.programs].some((program) => SWAP_PROGRAMS.has(program))) return null;
  const pools = poolsTouched(tx);
  if (pools < MIN_POOL_ACCOUNTS || someoneOnlyLost(tx)) return null;

  let tipLamports = 0;
  tx.accountKeys.forEach((key, i) => {
    if (JITO_TIP_ACCOUNTS.has(key)) tipLamports += (tx.postBalances[i] ?? 0) - (tx.preBalances[i] ?? 0);
  });
  const baseFee = tx.signatures * 5000;
  const priorityLamports = Math.max(tx.fee - baseFee, 0);

  const net = netOfOwner(tx, tx.signer);
  // Native change, before what was spent on the fee and tip, so that gross is measured.
  let sol = (tx.postBalances[0] ?? 0) - (tx.preBalances[0] ?? 0) + tx.fee + tipLamports;
  const wrapped = net.get(WRAPPED_SOL);
  if (wrapped) {
    sol += Number(wrapped.amount);
    net.delete(WRAPPED_SOL);
  }

  // Rent for opening temporary accounts moves native SOL by tiny amounts in either direction.
  const gained: { asset: string; amount: number }[] = [];
  for (const [mint, { amount, decimals }] of net) {
    const whole = Number(amount) / 10 ** decimals;
    if (whole > 0) gained.push({ asset: mint, amount: whole });
    else if (whole < 0) return null;
  }
  const solWhole = sol / LAMPORTS;
  if (solWhole > 0) gained.push({ asset: 'SOL', amount: solWhole });
  else if (solWhole < -0.003) return null;

  if (gained.length !== 1) return null;
  const [gain] = gained;
  if (gain!.amount <= DUST_SHARE * 0.001) return null;
  return { signer: tx.signer, gainAsset: gain!.asset, gain: gain!.amount, tipLamports, priorityLamports, pools };
}
