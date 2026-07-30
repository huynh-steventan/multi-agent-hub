import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Small typed wrapper over localStorage.
 *
 * The hub is redeployed constantly — it is one operator iterating on their own
 * tool — and every redeploy reloads the page. Anything the user would consider
 * "where I was" (an unsent message, which sessions are open, the half-filled
 * new-session form) has to outlive that reload or the tool feels like it
 * discards work every time it improves.
 *
 * Storage is best-effort: a private-mode browser that throws on write must not
 * take the UI down with it.
 */
const PREFIX = 'multi-agent-hub:';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled — the in-memory state is still correct.
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // As above.
  }
}

/** `useState` that reads its initial value from, and writes every change to, localStorage. */
export function usePersistentState<T>(key: string, fallback: T): [T, (updater: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => load(key, fallback));

  // Keyed by ref so the setter identity stays stable across renders.
  const keyRef = useRef(key);
  keyRef.current = key;

  const set = useCallback((updater: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const next = typeof updater === 'function' ? (updater as (p: T) => T)(prev) : updater;
      save(keyRef.current, next);
      return next;
    });
  }, []);

  // Following a key change (e.g. switching sessions) means re-reading its value.
  const previousKey = useRef(key);
  useEffect(() => {
    if (previousKey.current === key) return;
    previousKey.current = key;
    setValue(load(key, fallback));
    // `fallback` is intentionally not a dependency: it is the initial value,
    // not a value to snap back to whenever a caller passes a new literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, set];
}
