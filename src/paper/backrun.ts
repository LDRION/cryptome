import type { Visibility } from './streams.ts';

/**
 * Estimates what trading right behind a visible transaction would have earned. Only the
 * part of a gap created by transactions seen in advance counts, since nobody can place a
 * trade behind a transaction they did not know about.
 */

export interface GapPart {
  usd: number;
  visibility: Visibility;
}

export interface BackrunAssumptions {
  /** Share of profit paid to the builder to land right behind a public transaction. */
  bidShare: number;
  /** Share kept after MEV-Share returns its refund to the user. */
  sharedKeep: number;
  /** How far above a rival's payment a bid must go. */
  outbidFactor: number;
}

export interface BackrunResult {
  /** Created by transactions seen in full, which any bot can trade behind. */
  publicUsd: number;
  /** Created by transactions known from MEV-Share hints with matching details. */
  sharedUsd: number;
  soft: number;
  real: number;
  brutal: number;
}

const sumOf = (parts: GapPart[], classes: Visibility[]): number =>
  parts.filter((part) => classes.includes(part.visibility)).reduce((total, part) => total + part.usd, 0);

export function settleBackrun(parts: GapPart[], rivalPaidUsd: number, closedSameBlock: boolean, a: BackrunAssumptions): BackrunResult {
  const publicUsd = sumOf(parts, ['mempool']);
  const sharedUsd = sumOf(parts, ['mev-share-exact', 'mev-share-topics']);
  const soft = publicUsd * (1 - a.bidShare) + sharedUsd * a.sharedKeep;

  const toBeat = rivalPaidUsd * a.outbidFactor;
  // A low rival payment may only mean nobody contested the trade. A new bidder would push
  // the price up, so even an easy win keeps no more than the usual share.
  const publicReal = publicUsd > toBeat ? Math.min(publicUsd - toBeat, publicUsd * (1 - a.bidShare)) : 0;
  const sharedReal = sharedUsd > toBeat ? sharedUsd * a.sharedKeep : 0;

  return {
    publicUsd,
    sharedUsd,
    soft,
    real: publicReal + sharedReal,
    brutal: closedSameBlock ? 0 : soft,
  };
}
