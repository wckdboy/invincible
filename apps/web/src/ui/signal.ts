/*
 * The whole state library: a value you can read, set and watch. Views subscribe
 * through their Scope so subscriptions end when the view does.
 */

export type Unsubscribe = () => void;

export class Signal<T> {
  private readonly listeners = new Set<(value: T) => void>();

  constructor(private current: T) {}

  get value(): T {
    return this.current;
  }

  set(next: T): void {
    if (Object.is(next, this.current)) return;
    this.current = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  update(fn: (value: T) => T): void {
    this.set(fn(this.current));
  }

  /** Calls `listener` now and on every change. */
  watch(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` on changes only. */
  subscribe(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const signal = <T>(value: T): Signal<T> => new Signal(value);
