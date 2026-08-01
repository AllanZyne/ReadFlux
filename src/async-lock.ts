type AsyncLock = { current: boolean };

export async function runExclusive<T>(lock: AsyncLock, operation: () => Promise<T>) {
  if (lock.current) return { started: false } as const;
  lock.current = true;
  try {
    return { started: true, value: await operation() } as const;
  } finally {
    lock.current = false;
  }
}
