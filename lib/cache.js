export class VaultCache {
  constructor(maxSize = 100, defaultTtlMs = 30000) {
    this.maxSize = maxSize;
    this.defaultTtlMs = defaultTtlMs;
    this.entries = new Map();
    this.order = [];
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.order = this.order.filter((item) => item !== key);
      this.misses++;
      return null;
    }

    this.hits++;
    this.#touch(key);
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
    this.#touch(key);

    while (this.order.length > this.maxSize) {
      const oldestKey = this.order.shift();
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    return value;
  }

  invalidate(pattern) {
    if (pattern === "*") {
      this.clear();
      return;
    }

    const keys = [...this.entries.keys()];
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : null;

    for (const key of keys) {
      const matches = prefix !== null ? key.startsWith(prefix) : key === pattern;
      if (matches) {
        this.entries.delete(key);
        this.order = this.order.filter((item) => item !== key);
      }
    }
  }

  clear() {
    this.entries.clear();
    this.order = [];
  }

  stats() {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
    };
  }

  #touch(key) {
    this.order = this.order.filter((item) => item !== key);
    this.order.push(key);
  }
}
