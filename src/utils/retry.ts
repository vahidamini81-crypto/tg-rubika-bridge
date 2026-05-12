export type RetryOptions = {
  retries?: number;
  delaysMs?: number[];
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
};

const defaultDelaysMs = [1000, 3000, 10000];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const delaysMs = options.delaysMs ?? defaultDelaysMs;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const delayMs = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 10000;
      options.onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
