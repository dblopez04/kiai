export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spaces requests at least `intervalMs` apart. One instance is shared by every osu! request in
 * a process, including beatmap downloads for local PP, to stay under osu!'s ~60 requests/minute.
 */
export class RateLimiter {
  readonly intervalMs: number;
  #next = 0;
  #now: () => number;
  #sleep: Sleep;

  constructor(intervalMs = 1100, now: () => number = Date.now, wait: Sleep = sleep) {
    this.intervalMs = intervalMs;
    this.#now = now;
    this.#sleep = wait;
  }

  async wait(): Promise<void> {
    const now = this.#now();
    const slot = Math.max(now, this.#next);
    this.#next = slot + this.intervalMs;
    if (slot > now) await this.#sleep(slot - now);
  }
}
