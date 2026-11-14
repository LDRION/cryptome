import type { Rpc } from '../rpc.ts';

/** One way into the network. Named so a log can say which path worked, without its URL or key. */
export interface BroadcastNode {
  name: string;
  rpc: Rpc;
}

export interface NodeAnswer {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/** A node that has not answered by now is not helping this transaction reach its block. */
const NODE_TIMEOUT_MS = 3000;

/**
 * Measured by sending through each alone and timing when the others knew (`pnpm sender:probe`, 04.11).
 * Tenderly and Nodies spread a transaction to everyone in under a second. Publicnode took 18 s to
 * reach one other node and dRPC 3-10 s, so they are only a fallback. BloXroute and 1RPC reached
 * none: their transactions were mined by builders, so they never get to a self-built block.
 */
export const PUBLIC_NODES: readonly { name: string; url: string }[] = [
  { name: 'publicnode', url: 'https://ethereum-rpc.publicnode.com' },
  { name: 'tenderly', url: 'https://gateway.tenderly.co/public/mainnet' },
  { name: 'nodies', url: 'https://eth-pokt.nodies.app' },
  { name: 'drpc-public', url: 'https://eth.drpc.org' },
];

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

/**
 * Hands a signed transaction to every node at once. `accepted` settles on the first node to take
 * it, so one that hangs can never hold the attempt up. `answers` finishes when all have replied.
 */
export function broadcast(nodes: readonly BroadcastNode[], signed: `0x${string}`, now: () => number = Date.now, timeoutMs = NODE_TIMEOUT_MS): { accepted: Promise<`0x${string}`>; answers: Promise<NodeAnswer[]> } {
  const started = now();
  const calls = nodes.map((node) => withTimeout(node.rpc.call<`0x${string}`>('eth_sendRawTransaction', [signed]), timeoutMs));
  const answers = Promise.all(
    calls.map((call, i) =>
      call.then(
        (): NodeAnswer => ({ name: nodes[i]!.name, ok: true, ms: now() - started }),
        (err: Error): NodeAnswer => ({ name: nodes[i]!.name, ok: false, ms: now() - started, error: err.message.slice(0, 120) }),
      ),
    ),
  );
  const accepted = Promise.any(calls).catch(() => {
    throw new Error('every node refused the transaction');
  });
  return { accepted, answers };
}
