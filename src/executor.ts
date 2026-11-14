import { readFile } from 'node:fs/promises';
import { decodeFunctionResult, encodeDeployData, encodeFunctionData, type Abi } from 'viem';
import { v4PoolId } from './paper/vetting.ts';
import type { PoolMeta } from './paper/pools.ts';
import type { Rpc } from './rpc.ts';

/**
 * Runs a route through the real contract in a real EVM, on the chain's real state at a past
 * block, by placing the contract's code at an address inside eth_call. Nothing is sent to
 * the network and no money exists, so it can check any trade the emulator claims to have won.
 */

const artifact = JSON.parse(await readFile(new URL('../contracts/Executor.json', import.meta.url), 'utf8')) as { abi: Abi; bytecode: `0x${string}`; deployedBytecode: `0x${string}` };

export const EXECUTOR = '0x00000000000000000000000000000000c0ffee01';
export const SIMULATED_OWNER = '0x00000000000000000000000000000000a11ce001';
export const SIMULATED_TREASURY = '0x00000000000000000000000000000000b0b00001';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

let runtimeCode: Promise<`0x${string}`> | null = null;

/**
 * The owner and treasury are written into the code when the constructor runs, so the code to
 * simulate comes from running the real constructor rather than from the compiled file.
 */
export function executorCode(rpc: Rpc): Promise<`0x${string}`> {
  runtimeCode ??= rpc.call<`0x${string}`>('eth_call', [{ from: SIMULATED_OWNER, gas: SIMULATION_GAS, data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [SIMULATED_TREASURY] }) }, 'latest']);
  return runtimeCode;
}
const SIMULATION_GAS = '0x1c9c380';
const KINDS = { v2: 0, v3: 1, v4: 2 } as const;

export interface RouteHop {
  kind: PoolMeta['kind'];
  /** Zero for V4, whose pools all live inside one contract. */
  pool: string;
  zeroForOne: boolean;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  tickSpacing: number;
  nativeLeg: boolean;
  /** This hop's price when the trade was decided. Only read when the route states a gap. */
  priceAtDecision: bigint;
}

/** The route's gap when decided and the narrowest still worth taking, as fractions of 1e18. Zero skips the check. */
export interface GapTerms {
  startGap: bigint;
  minGap: bigint;
}

export const NO_GAP_CHECK: GapTerms = { startGap: 0n, minGap: 0n };

export type Simulation = { ok: true; profit: bigint; outs: bigint[]; gasUsed: bigint; checkGas: bigint } | { ok: false; reason: string };

/** V4 routes treat native ETH as WETH, so only the id reveals which one the pool really holds. */
export function holdsNativeEth(meta: PoolMeta, wrappedNative: string): boolean {
  if (meta.kind !== 'v4') return false;
  if (meta.token0 !== wrappedNative) return false;
  const id = v4PoolId({ currency0: ZERO_ADDRESS, currency1: meta.token1, fee: meta.fee, tickSpacing: meta.tickSpacing, hooks: ZERO_ADDRESS });
  return id.toLowerCase() === meta.address.toLowerCase();
}

/** Turns a route's token list and pool list into the swaps the contract performs. */
export function hopsOf(tokens: string[], pools: string[], metas: ReadonlyMap<string, PoolMeta>, wrappedNative: string, pricesAtDecision: readonly bigint[] = []): RouteHop[] {
  return pools.map((address, i) => {
    const meta = metas.get(address);
    if (!meta) throw new Error(`Unknown pool ${address}`);
    const tokenIn = tokens[i]!;
    const tokenOut = tokens[(i + 1) % tokens.length]!;
    if (!(meta.token0 === tokenIn && meta.token1 === tokenOut) && !(meta.token1 === tokenIn && meta.token0 === tokenOut)) {
      throw new Error(`Pool ${address} does not trade ${tokenIn} for ${tokenOut}`);
    }
    return {
      kind: meta.kind,
      pool: meta.kind === 'v4' ? ZERO_ADDRESS : address,
      zeroForOne: meta.token0 === tokenIn,
      tokenIn,
      tokenOut,
      fee: meta.fee,
      tickSpacing: meta.tickSpacing,
      nativeLeg: holdsNativeEth(meta, wrappedNative),
      priceAtDecision: pricesAtDecision[i] ?? 0n,
    };
  });
}

const hopArguments = (hops: RouteHop[]): unknown[] =>
  hops.map((hop) => ({
    kind: KINDS[hop.kind],
    pool: hop.pool,
    zeroForOne: hop.zeroForOne,
    tokenIn: hop.tokenIn,
    tokenOut: hop.tokenOut,
    fee: hop.fee,
    tickSpacing: hop.tickSpacing,
    nativeLeg: hop.nativeLeg,
    priceAtDecision: hop.priceAtDecision,
  }));

export function encodeRun(start: string, amountIn: bigint, hops: RouteHop[], minProfit: bigint, targetBlock: bigint = 0n, gap: GapTerms = NO_GAP_CHECK): `0x${string}` {
  return encodeFunctionData({ abi: artifact.abi, functionName: 'run', args: [start, amountIn, hopArguments(hops), minProfit, gap.startGap, gap.minGap, targetBlock] });
}

export function decodeRunProfit(returned: `0x${string}`): bigint {
  return (decodeFunctionResult({ abi: artifact.abi, functionName: 'run', data: returned }) as [bigint, bigint[], bigint, bigint])[0];
}

export interface BatchRoute extends GapTerms {
  start: string;
  amountIn: bigint;
  hops: RouteHop[];
  minProfit: bigint;
  gasLimit: bigint;
}

export function encodeRunBatch(routes: BatchRoute[], targetBlock: bigint = 0n): `0x${string}` {
  return encodeFunctionData({
    abi: artifact.abi,
    functionName: 'runBatch',
    args: [routes.map((route) => ({ start: route.start, amountIn: route.amountIn, hops: hopArguments(route.hops), minProfit: route.minProfit, startGap: route.startGap, minGap: route.minGap, gasLimit: route.gasLimit })), targetBlock],
  });
}

/**
 * Whether the code at an address is exactly this build with this owner and treasury. The sender
 * refuses to start otherwise: calling a function an older contract lacks would only burn gas.
 */
export async function deployedMatchesBuild(rpc: Rpc, address: string, owner: string, treasury: string): Promise<boolean> {
  const [expected, actual] = await Promise.all([
    rpc.call<string>('eth_call', [{ from: owner, gas: SIMULATION_GAS, data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [treasury] }) }, 'latest']),
    rpc.call<string>('eth_getCode', [address, 'latest']),
  ]);
  return expected.toLowerCase() === actual.toLowerCase();
}

export interface SimulationInput {
  start: string;
  amountIn: bigint;
  hops: RouteHop[];
  blockTag: string;
  minProfit?: bigint;
  targetBlock?: bigint;
  gap?: GapTerms;
  /** Extra state for the simulation, such as a hostile contract placed at an address. */
  overrides?: Record<string, unknown>;
}

export type BatchSimulation = { ok: true; succeeded: bigint } | { ok: false; reason: string };

export async function simulateBatch(rpc: Rpc, input: { routes: BatchRoute[]; blockTag: string; targetBlock?: bigint; overrides?: Record<string, unknown> }): Promise<BatchSimulation> {
  try {
    const overrides = { [EXECUTOR]: { code: await executorCode(rpc) }, ...input.overrides };
    const call = { from: SIMULATED_OWNER, to: EXECUTOR, gas: SIMULATION_GAS, data: encodeRunBatch(input.routes, input.targetBlock ?? 0n) };
    const raw = await rpc.call<`0x${string}`>('eth_call', [call, input.blockTag, overrides]);
    return { ok: true, succeeded: decodeFunctionResult({ abi: artifact.abi, functionName: 'runBatch', data: raw }) as bigint };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.slice(0, 160) };
  }
}

/** The contract starts empty, exactly as it would on chain: the trade has to fund itself. */
export async function simulateCycle(rpc: Rpc, input: SimulationInput): Promise<Simulation> {
  try {
    const overrides = { [EXECUTOR]: { code: await executorCode(rpc) }, ...input.overrides };
    const call = { from: SIMULATED_OWNER, to: EXECUTOR, gas: SIMULATION_GAS, data: encodeRun(input.start, input.amountIn, input.hops, input.minProfit ?? 0n, input.targetBlock ?? 0n, input.gap) };
    const raw = await rpc.call<`0x${string}`>('eth_call', [call, input.blockTag, overrides]);
    const [profit, outs, gasUsed, checkGas] = decodeFunctionResult({ abi: artifact.abi, functionName: 'run', data: raw }) as [bigint, bigint[], bigint, bigint];
    return { ok: true, profit, outs, gasUsed, checkGas };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.slice(0, 160) };
  }
}
