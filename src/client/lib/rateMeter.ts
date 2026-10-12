/**
 * Moving-window throughput estimate. Reports nothing until it has seen at
 * least `minElapsedMs` of progress, so speeds and ETAs are only shown once
 * they are meaningful.
 */
export interface RateEstimate {
  bytesPerSecond: number | null;
  etaSeconds: number | null;
}

export class RateMeter {
  private samples: Array<{ t: number; bytes: number }> = [];

  constructor(
    private readonly windowMs = 4000,
    private readonly minElapsedMs = 1500,
    private readonly now: () => number = () => performance.now(),
  ) {}

  reset(): void {
    this.samples = [];
  }

  push(bytes: number, total: number): RateEstimate {
    const t = this.now();
    const list = this.samples;
    if (list.length === 0 || bytes >= list[list.length - 1]!.bytes) list.push({ t, bytes });
    while (list.length > 2 && t - list[0]!.t > this.windowMs) list.shift();
    const first = list[0]!;
    const elapsed = t - first.t;
    if (elapsed < this.minElapsedMs || bytes <= first.bytes)
      return { bytesPerSecond: null, etaSeconds: null };
    const bytesPerSecond = ((bytes - first.bytes) / elapsed) * 1000;
    return {
      bytesPerSecond,
      etaSeconds: bytesPerSecond > 0 ? Math.max(0, (total - bytes) / bytesPerSecond) : null,
    };
  }
}
