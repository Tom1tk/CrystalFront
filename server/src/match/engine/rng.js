/**
 * Mulberry32 — fast, seedable, deterministic PRNG.
 * Used in place of Math.random() for all simulation randomness so that
 * matches are fully reproducible from a seed.
 */
export class Rng {
    state;
    constructor(seed) {
        this.state = seed >>> 0;
    }
    /** Returns a float in [0, 1). */
    random() {
        this.state = (this.state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
        t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    /** Returns a random integer in [min, max] inclusive. */
    randInt(min, max) {
        return Math.floor(this.random() * (max - min + 1)) + min;
    }
}
