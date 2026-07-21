interface SampleBatcherOptions<T> {
  intervalMs: number;
  onFlush: (items: T[]) => void;
}

export class SampleBatcher<T> {
  private queue: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SampleBatcherOptions<T>) {}

  push(item: T): void {
    this.pushMany([item]);
  }

  pushMany(items: T[]): void {
    if (items.length === 0) return;
    this.queue.push(...items);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => this.flush(), this.options.intervalMs);
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    this.options.onFlush(items);
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
  }
}
