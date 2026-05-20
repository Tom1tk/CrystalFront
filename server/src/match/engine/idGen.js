/**
 * Monotonic counter ID generator.
 * Replaces randomUUID() for entity and resource-node IDs so that IDs are
 * deterministic given a seed — a requirement for replay correctness.
 */
export class IdGen {
    counter;
    constructor(start = 1) {
        this.counter = start;
    }
    next() {
        return `e${this.counter++}`;
    }
    /** Current counter value — useful for serialising/restoring state. */
    get current() {
        return this.counter;
    }
}
