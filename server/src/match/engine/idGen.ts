/**
 * Monotonic counter ID generator.
 * Replaces randomUUID() for entity and resource-node IDs so that IDs are
 * deterministic given a seed — a requirement for replay correctness.
 */
export class IdGen {
  private counter: number;

  constructor(start: number = 1) {
    this.counter = start;
  }

  next(): string {
    return `e${this.counter++}`;
  }

  /** Current counter value — useful for serialising/restoring state. */
  get current(): number {
    return this.counter;
  }
}
