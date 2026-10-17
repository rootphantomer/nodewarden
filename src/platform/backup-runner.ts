import type { Env } from '../types';
import type { BackupRunnerPort } from './types';

const DEGRADED_RUNNER_MESSAGE =
  'Backup transfer runs require the Cloudflare Durable Objects runtime and are unavailable on this platform';

/**
 * Cloudflare default: dispatches the internal `https://backup-transfer/internal/*`
 * API to the named `BackupTransferRunner` object, preserving the status/JSON
 * contract callers already handle (409 concurrency, 404 missing, error body).
 */
export function createDurableObjectBackupRunner(
  namespace: NonNullable<Env['BACKUP_TRANSFER_RUNNER']>
): BackupRunnerPort {
  return {
    dispatch(runnerName, input, init): Promise<Response> {
      const id = namespace.idFromName(runnerName);
      const stub = namespace.get(id);
      return stub.fetch(input, init);
    },
  };
}

/**
 * Degraded default for platforms without Durable Objects. Returns a plain
 * `503` so every caller's existing `response.ok` / error-body handling turns
 * into a well-defined "backup unavailable" error instead of hanging or
 * crashing on an undefined namespace.
 */
export function createDegradedBackupRunner(): BackupRunnerPort {
  return {
    async dispatch(): Promise<Response> {
      return Response.json(
        { error: DEGRADED_RUNNER_MESSAGE },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    },
  };
}

/** Resolve the runner implementation from whatever the current platform provides. */
export function getBackupRunner(env: Env): BackupRunnerPort {
  if (env.BACKUP_TRANSFER_RUNNER) return createDurableObjectBackupRunner(env.BACKUP_TRANSFER_RUNNER);
  return createDegradedBackupRunner();
}
