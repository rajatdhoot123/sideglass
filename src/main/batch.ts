/**
 * Collects items keyed by id and flushes them together after `ms`. A later item with the
 * same id replaces the earlier one, so a request that updates several times in one window
 * is sent once, in its latest state.
 */
export class Batcher<T extends { id: string }> {
  private pending = new Map<string, T>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly flushTo: (items: T[]) => void,
    private readonly ms = 100,
  ) {}

  push(item: T): void {
    this.pending.set(item.id, item)
    this.timer ??= setTimeout(() => this.flush(), this.ms)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending.size === 0) return
    const items = [...this.pending.values()]
    this.pending = new Map()
    this.flushTo(items)
  }

  /** Drop anything not yet sent, for example after the capture is cleared. */
  discard(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = new Map()
  }
}
