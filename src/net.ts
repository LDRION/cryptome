import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Sends this process's traffic straight out of the network card, past a VPN that stays on for
 * everything else on the computer. On 2026-11-06 the sender handled a block in 2.9 s without the VPN
 * against 4.1 s with it, a call to the node took 58 ms instead of 73 ms, and VPN drops stopped
 * touching it. Fetch and WebSocket both go through the global dispatcher, so one binding covers all.
 */

/** Adapters that carry a tunnel rather than the line itself. */
const TUNNEL = /happ|xray|tun|tap|vpn|wireguard|openvpn|vethernet|loopback|bluetooth/i;

/** Picks the card that has a gateway and is no tunnel, from "alias|address" lines. */
export function pickCard(lines: string): string | null {
  for (const line of lines.split(/\r?\n/)) {
    const [alias, address] = line.trim().split('|');
    if (alias && address && !TUNNEL.test(alias) && /^\d+\.\d+\.\d+\.\d+$/.test(address)) return address;
  }
  return null;
}

/** The address to send from, or null to leave the routing as it is. DIRECT_LOCAL_ADDRESS overrides the search. */
export function directAddress(): string | null {
  if (process.env.DIRECT_LOCAL_ADDRESS) return process.env.DIRECT_LOCAL_ADDRESS;
  if (process.platform !== 'win32') return null;
  try {
    const list = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | ForEach-Object { $_.InterfaceAlias + '|' + @($_.IPv4Address)[0].IPAddress }"], { encoding: 'utf8', timeout: 20_000 });
    return pickCard(list);
  } catch {
    return null;
  }
}

/** Whether the address still belongs to this computer. A new one from the router means starting again. */
export function stillHere(address: string): boolean {
  return Object.values(networkInterfaces()).some((list) => list?.some((entry) => entry.address === address));
}

export function bindOutgoing(address: string): void {
  // It has to be the agent's own localAddress: tried on 2026-11-06, connect.localAddress left the socket on
  // the VPN. IPv4 only, as the bound address is one and an IPv6 answer from the name lookup could not use it.
  setGlobalDispatcher(new Agent({ localAddress: address, connect: { family: 4 } }));
}
