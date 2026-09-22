/** Bounds in-flight requests so a large corpus never fans out unboundedly. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("semaphore limit must be >= 1");
  }

  /**
   * Run `task` when a slot frees. A task woken after `signal` aborted is not
   * started: once one batch has failed, its siblings must not keep spending.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((wake) => this.waiting.push(wake));
    if (signal?.aborted) {
      this.waiting.shift()?.();
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error(String(signal.reason ?? "aborted"));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
