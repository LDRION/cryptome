export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

/** Mulberry32, so that a sample can be reproduced from its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Confidence interval for the mean, resampling whole windows because hits cluster in time. */
export function bootstrapMeanInterval(values: number[], level = 0.9, samples = 2000, seed = 1): [number, number] {
  if (values.length === 0) return [0, 0];
  const random = seededRandom(seed);
  const means = Array.from({ length: samples }, () => {
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[Math.floor(random() * values.length)]!;
    return total / values.length;
  });
  const tail = (1 - level) / 2;
  return [quantile(means, tail), quantile(means, 1 - tail)];
}

/**
 * Picks one window at a random offset inside each equal slice of the span. Even spacing
 * would hit the same hours every day and alias with the daily trading cycle.
 */
export function sampleWindows(head: number, spanBlocks: number, windows: number, blocksPerWindow: number, seed = 1): number[] {
  const slice = Math.floor(spanBlocks / windows);
  if (slice < blocksPerWindow) throw new Error(`Windows overlap: slice ${slice} < ${blocksPerWindow} blocks`);
  const random = seededRandom(seed);
  return Array.from({ length: windows }, (_, w) => head - spanBlocks + w * slice + Math.floor(random() * (slice - blocksPerWindow + 1)));
}
