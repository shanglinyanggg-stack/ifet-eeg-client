interface SampleBatcherOptions<T> {
  intervalMs: number;
  maxItems?: number;
  onFlush: (items: T[]) => void;
  onDrop?: (count: number) => void;
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
    const maxItems = Math.max(1, Math.floor(this.options.maxItems ?? Number.MAX_SAFE_INTEGER));
    if (this.queue.length > maxItems) {
      const dropped = this.queue.length - maxItems;
      this.queue.splice(0, dropped);
      this.options.onDrop?.(dropped);
    }
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
