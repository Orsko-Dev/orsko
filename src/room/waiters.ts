interface Waiter {
  readonly since: number;
  readonly resolve: () => void;
}

export class WaiterRegistry {
  private waiters: readonly Waiter[] = [];

  add(since: number, resolve: () => void): () => void {
    const w: Waiter = { since, resolve };
    this.waiters = [...this.waiters, w];
    return () => {
      this.waiters = this.waiters.filter((x) => x !== w);
    };
  }

  wakeAll(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w.resolve();
  }

  count(): number {
    return this.waiters.length;
  }
}
