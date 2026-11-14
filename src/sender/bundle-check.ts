import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import type { Rpc } from '../rpc.ts';

/**
 * Runs a bundle at the very top of its block, before anyone else's transaction can get in its way,
 * twice. The first run asks only whether our trade goes through. The second takes the signed
 * transactions exactly as they are, with nonce, fees and balance checked against the block's real
 * base fee, as a builder would. A bundle that fails either way could never land, whatever it bid, so
 * this tells a fault of ours apart from an auction lost to a rival. It sends nothing.
 */

export interface CallResult {
  status: string;
  gasUsed?: number;
  /** What a reverted call gave back, as the node reports it. */
  revert?: string;
}

export interface BundleCheck {
  /**
   * Every transaction of the bundle went through at the top of its block, ours last. A builder drops a
   * bundle in which any of them fails, so a failed opener counts against it too. Fees are not charged here.
   */
  ok: boolean;
  /** Why the first failed transaction stopped, marked when it was the one ahead of ours. */
  reason?: string;
  gasUsed?: number;
  /** Every transaction of the bundle, in its order. */
  calls?: CallResult[];
  /** The signed transactions are valid as they stand: nonce, fees and balance. Absent if that could not be asked. */
  valid?: boolean;
  /** Why the node refused them, or why the question could not be asked. */
  invalid?: string;
  validityError?: string;
}

interface SimulatedCall {
  status: string;
  gasUsed?: string;
  returnData?: string;
  error?: { message?: string; data?: string };
}

const hex = (value: bigint | number): `0x${string}` => `0x${value.toString(16)}`;
/** A failure to reach the node says nothing about the bundle, unlike a refusal from it. */
const isTransport = (message: string): boolean => /HTTP \d{3}|no answer|fetch failed|empty result|ECONN|socket|network/i.test(message);
const resultOf = (call: SimulatedCall): CallResult => ({
  status: call.status,
  ...(call.gasUsed ? { gasUsed: Number(BigInt(call.gasUsed)) } : {}),
  ...(call.status !== '0x1' ? { revert: (call.error?.data ?? call.returnData ?? call.error?.message ?? '').slice(0, 200) } : {}),
});

export async function checkAtTopOfBlock(rpc: Rpc, txs: readonly `0x${string}`[], targetBlock: number): Promise<BundleCheck> {
  const parsed = await Promise.all(
    txs.map(async (raw) => {
      const tx = parseTransaction(raw);
      const from = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });
      const plain = { from, to: tx.to!, data: tx.data ?? '0x', value: hex(tx.value ?? 0n), gas: hex(tx.gas!) };
      const fees = tx.maxFeePerGas !== undefined ? { maxFeePerGas: hex(tx.maxFeePerGas), maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas ?? 0n) } : { gasPrice: hex(tx.gasPrice ?? 0n) };
      const signed = { ...plain, nonce: hex(tx.nonce ?? 0), ...fees, ...(tx.accessList?.length ? { accessList: tx.accessList } : {}) };
      return { plain, signed };
    }),
  );
  const ask = (calls: Record<string, unknown>[], validation: boolean) =>
    rpc.call<{ calls: SimulatedCall[] }[]>('eth_simulateV1', [{ blockStateCalls: [{ blockOverrides: { number: hex(targetBlock) }, calls }], validation }, hex(targetBlock - 1)]);

  const answer = await ask(parsed.map(({ plain }) => plain), false);
  const calls = (answer[0]?.calls ?? []).map(resultOf);
  const ours = calls.at(-1);
  const failed = calls.findIndex((call) => call.status !== '0x1');
  const reason = failed === -1 ? undefined : `${failed < calls.length - 1 ? 'opener: ' : ''}${calls[failed]!.revert || 'reverted'}`;
  const check: BundleCheck = ours && calls.length === txs.length
    ? { ok: failed === -1, ...(reason !== undefined ? { reason } : {}), ...(ours.gasUsed !== undefined ? { gasUsed: ours.gasUsed } : {}), calls }
    : { ok: false, reason: 'no answer' };

  try {
    await ask(parsed.map(({ signed }) => signed), true);
    check.valid = true;
  } catch (err) {
    const message = (err as Error).message.replace(/^eth_simulateV1: /, '').slice(0, 200);
    if (isTransport(message)) check.validityError = message;
    else {
      check.valid = false;
      check.invalid = message;
    }
  }
  return check;
}
