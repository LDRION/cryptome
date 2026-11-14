import type { Rpc } from '../rpc.ts';

const READ_RESERVES = '0x0902f1ac';
const READ_SLOT0 = '0x3850c7bd';
const V4_STATE_VIEW = '0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
const V4_GET_SLOT0 = '0xc815641c';

const word = (hex: string, index: number): bigint => BigInt(`0x${hex.slice(2 + index * 64, 2 + (index + 1) * 64)}`);

/** A pool's price at a block, read from the chain in the form the contract compares. */
export async function priceOnChain(rpc: Rpc, kind: string, zeroForOne: boolean, address: string, blockTag: string): Promise<bigint> {
  if (kind === 'v2') {
    const raw = await rpc.call<string>('eth_call', [{ to: address, data: READ_RESERVES }, blockTag]);
    const [reserveIn, reserveOut] = zeroForOne ? [word(raw, 0), word(raw, 1)] : [word(raw, 1), word(raw, 0)];
    return (reserveOut << 96n) / reserveIn;
  }
  if (kind === 'v3') return word(await rpc.call<string>('eth_call', [{ to: address, data: READ_SLOT0 }, blockTag]), 0);
  return word(await rpc.call<string>('eth_call', [{ to: V4_STATE_VIEW, data: `${V4_GET_SLOT0}${address.slice(2)}` }, blockTag]), 0);
}
