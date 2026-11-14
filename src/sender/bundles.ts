import { keccak256, serializeTransaction, stringToBytes, type PrivateKeyAccount } from 'viem';
import type { NodeAnswer } from './broadcast.ts';

/**
 * Private bundles go straight to builders and never touch the public mempool. A builder simulates a
 * bundle first and discards it if its transaction reverts ("SimulationFail" in Titan's docs, "if any
 * transaction in the bundle fails, the entire bundle fails" in BuilderNet's), so nothing reaches the
 * chain and no gas is paid. A trade that loses here costs nothing, unlike one sent in public.
 */

export interface BundleEndpoint {
  name: string;
  url: string;
  needsSignature: boolean;
}

export const EUREKA_URL = 'https://rpc.eurekabuilder.xyz';

/**
 * Of the last 600 blocks on 2026-11-05, Titan built 50.5%, Quasar 17.8%, BuilderNet 17.3%, Eureka 2.2% and
 * Bombora, bobthebuilder and BTCS about 1% each. A bundle that lands nowhere costs nothing, so it goes to all of
 * them. Titan and Quasar each put a control bundle of ours into a block of theirs; the addresses of the
 * smaller ones come from the Flashbots builder registry, and each accepted a bundle.
 */
export const BUILDER_ENDPOINTS: readonly BundleEndpoint[] = [
  { name: 'flashbots', url: 'https://relay.flashbots.net', needsSignature: true },
  { name: 'buildernet', url: 'https://rpc.buildernet.org', needsSignature: true },
  { name: 'titan', url: 'https://eu.rpc.titanbuilder.xyz', needsSignature: false },
  { name: 'quasar', url: 'https://rpc.quasar.win', needsSignature: true },
  { name: 'eureka', url: EUREKA_URL, needsSignature: true },
  { name: 'bombora', url: 'https://rpc.bombora.build', needsSignature: true },
  { name: 'bobthebuilder', url: 'https://rpc.bobthebuilder.xyz', needsSignature: true },
  { name: 'btcs', url: 'https://flashbots.btcs.com', needsSignature: true },
];

/**
 * The share of its profit a bundle offers the builder. Recorded builder blocks said 25% kept the most,
 * but they assumed that outbidding the winner's payment wins, which real attempts did not bear out, and
 * none of 99 bundles at 25% landed. So two bids run side by side, split by the parity of the target
 * block, which has nothing to do with the trade: that gives the curve from bid to landings no backtest
 * can. A bundle that does not land costs nothing, and one that does still covers its costs and the
 * minimum net, as the contract checks the profit before it finishes.
 */
export const bundleBidShare = (targetBlock: number): number => (targetBlock % 2 === 0 ? 0.6 : 0.25);

const BUNDLE_TIMEOUT_MS = 2000;

/**
 * What the builder itself says became of a bundle. Eureka answers eureka_getBundleStats without a
 * signature and keeps the record for about 30 days. Its status keeps the furthest stage reached:
 * Received, FailedToEnterOrderpool, EnteredOrderpool, FailedToPassToInitialSimulation,
 * InitialSimulationFail, InitialSimulationPass, ExcludedFromBlock, IncludedInBlock (in a block it
 * built, which need not have won), Submitted, Replaced or Cancelled. It simulates every bundle it
 * gets, so its verdict holds even for blocks someone else built.
 *
 * Read the status, not the error. Two unlandable bundles for the same block on 2026-11-05 both came
 * back with the error "HeadAdvanced": the one sent 1.4 s into the slot as InitialSimulationFail
 * (simulated, and failed), the one sent 11.2 s in as FailedToPassToInitialSimulation (too late to be
 * simulated at all). Only the second says a bundle came late.
 */
export interface BundleTrace {
  status: string;
  error?: string;
  builderPayment?: string;
  gasUsed?: number;
  landedValue?: string;
}

export async function traceAtEureka(bundleHash: string, fetcher: typeof fetch = fetch): Promise<BundleTrace> {
  const response = await fetcher(EUREKA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eureka_getBundleStats', params: [{ bundleHash }] }),
    signal: AbortSignal.timeout(10_000),
  });
  const answer = (await response.json()) as { result?: Record<string, unknown>; error?: { message?: string } };
  if (answer.error || !answer.result) throw new Error((answer.error?.message ?? `HTTP ${response.status}`).slice(0, 160));
  const { status, error, builderPayment, gasUsed, landedValue } = answer.result;
  return {
    status: typeof status === 'string' ? status : 'Received',
    ...(typeof error === 'string' ? { error: error.slice(0, 200) } : {}),
    ...(typeof builderPayment === 'string' ? { builderPayment } : {}),
    ...(typeof gasUsed === 'number' ? { gasUsed } : {}),
    ...(typeof landedValue === 'string' ? { landedValue } : {}),
  };
}

/** The value of the header some builders ask for: EIP-191 over the hex hash of the exact body. */
export async function signatureHeader(account: Pick<PrivateKeyAccount, 'address' | 'signMessage'>, body: string): Promise<string> {
  return `${account.address}:${await account.signMessage({ message: keccak256(stringToBytes(body)) })}`;
}

/**
 * Rebuilds the exact bytes of a pending transaction from its fields, so it can go first in a bundle with
 * our trade right behind it. Its own hash proves the rebuild: if they differ, the answer is null.
 */
export function rawOfPending(tx: Record<string, unknown>): `0x${string}` | null {
  try {
    const hex = (key: string): `0x${string}` => tx[key] as `0x${string}`;
    const big = (key: string): bigint => BigInt(hex(key));
    const common = { nonce: Number(big('nonce')), gas: big('gas'), to: hex('to'), value: big('value'), data: hex('input') };
    const signature = { r: hex('r'), s: hex('s') };
    const accessList = (tx.accessList ?? []) as readonly { address: `0x${string}`; storageKeys: readonly `0x${string}`[] }[];
    const type = BigInt(hex('type'));
    const raw =
      type === 2n
        ? serializeTransaction({ type: 'eip1559', chainId: Number(big('chainId')), ...common, maxFeePerGas: big('maxFeePerGas'), maxPriorityFeePerGas: big('maxPriorityFeePerGas'), accessList }, { ...signature, yParity: Number(BigInt(hex(tx.yParity !== undefined ? 'yParity' : 'v'))) })
        : type === 1n
          ? serializeTransaction({ type: 'eip2930', chainId: Number(big('chainId')), ...common, gasPrice: big('gasPrice'), accessList }, { ...signature, yParity: Number(BigInt(hex(tx.yParity !== undefined ? 'yParity' : 'v'))) })
          : type === 0n
            ? serializeTransaction({ type: 'legacy', ...(tx.chainId ? { chainId: Number(big('chainId')) } : {}), ...common, gasPrice: big('gasPrice') }, { ...signature, v: big('v') })
            : null;
    return raw && keccak256(raw) === tx.hash ? raw : null;
  } catch {
    return null;
  }
}

export interface BundleAnswer extends NodeAnswer {
  /** The builder's own name for the bundle, by which it can be asked about it later. */
  bundleHash?: string;
}

/** Hands signed transactions to every builder as one bundle, for one block only. One that fails holds up nobody. */
export async function sendBundle(
  endpoints: readonly BundleEndpoint[],
  txs: readonly `0x${string}`[],
  targetBlock: number,
  account: Pick<PrivateKeyAccount, 'address' | 'signMessage'>,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<BundleAnswer[]> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [{ txs, blockNumber: `0x${targetBlock.toString(16)}` }] });
  const started = now();
  const signature = endpoints.some((endpoint) => endpoint.needsSignature) ? await signatureHeader(account, body) : '';
  return Promise.all(
    endpoints.map(async ({ name, url, needsSignature }): Promise<BundleAnswer> => {
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(needsSignature ? { 'X-Flashbots-Signature': signature } : {}) },
          body,
          signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS),
        });
        const text = await response.text();
        const answer = JSON.parse(text) as { error?: { message?: string }; result?: { bundleHash?: string } };
        if (!response.ok || answer.error) return { name, ok: false, ms: now() - started, error: (answer.error?.message ?? `HTTP ${response.status}`).slice(0, 120) };
        const bundleHash = answer.result?.bundleHash;
        return { name, ok: true, ms: now() - started, ...(typeof bundleHash === 'string' ? { bundleHash } : {}) };
      } catch (err) {
        return { name, ok: false, ms: now() - started, error: (err as Error).message.slice(0, 120) };
      }
    }),
  );
}
