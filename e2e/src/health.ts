import { verboseLog } from './logger';

export interface WaitForHealthOptions {
  maxAttempts?: number;
  intervalMs?: number;
  initialDelayMs?: number;
  label?: string;
}

/**
 * Retry a health-check function until it reports success or attempts are
 * exhausted. Returns true when healthy, false on timeout.
 */
export async function waitForHealth(
  healthCheck: () => Promise<{ success: boolean }>,
  options?: WaitForHealthOptions,
): Promise<boolean> {
  const maxAttempts = options?.maxAttempts ?? 10;
  const intervalMs = options?.intervalMs ?? 2000;
  const initialDelayMs = options?.initialDelayMs ?? 0;
  const label = options?.label ?? 'Service';

  if (initialDelayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, initialDelayMs));
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await healthCheck();
    verboseLog(` 🔍 ${label} health check ${attempt}/${maxAttempts}: ${result.success ? '✅' : '❌'}`);

    if (result.success) {
      verboseLog(`  ✅ ${label} is healthy`);
      return true;
    }

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  verboseLog(`  ❌ ${label} failed to become healthy`);
  return false;
}
