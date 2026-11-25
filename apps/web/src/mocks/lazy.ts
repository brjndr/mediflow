/**
 * Sample data that is built the first time something reads it, not when the mock API starts.
 * The mock starts before the app renders, so every seed built eagerly at start-up is main-thread
 * time before the first paint (#1174): the 12,000 patients, the appointments and the inventory
 * together cost about a third of the start-up. A screen that never asks for them never pays.
 *
 * The result stands in for the value itself: reads, writes and method calls go to it. Build it
 * with `let rows = lazySeed(seed)` and reset it with `rows = lazySeed(seed)`.
 */
export function lazySeed<T extends object>(make: () => T): T {
  let built: T | undefined;
  const target = () => (built ??= make());
  return new Proxy({} as T, {
    get: (_, key) => {
      const value: unknown = Reflect.get(target(), key);
      return typeof value === 'function' ? value.bind(target()) : value;
    },
    set: (_, key, value) => Reflect.set(target(), key, value),
    has: (_, key) => Reflect.has(target(), key),
    ownKeys: () => Reflect.ownKeys(target()),
    getOwnPropertyDescriptor: (_, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target(), key);
      return descriptor && { ...descriptor, configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(target()),
  });
}
