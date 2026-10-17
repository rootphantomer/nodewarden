import type { Env } from '../types';
import type { BackupRunnerPort } from './types';
import { handleBackupTransferRequest } from '../handlers/backup-transfer-dispatch';
import { createDatabaseJobLease } from '../services/job-lease';

const RUNNER_INTERNAL_URL = 'https://backup-transfer';

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
 * Fallback for platforms without Durable Objects (EdgeOne, tests): executes
 * the same `/internal/*` endpoints inline in the request thread, backed by a
 * config-row CAS lease for the job serialization the DO would provide.
 *
 * Limits versus the DO runtime: the work shares the platform function's CPU/
 * wall-clock budget (EdgeOne maxDuration), and download/restore streaming is
 * buffered rather than out-of-context — acceptable for the default backup
 * schedule sizes.
 */
export function createInlineBackupRunner(env: Env): BackupRunnerPort {
  return {
    async dispatch(_runnerName, input, init): Promise<Response> {
      const url = input.startsWith(`${RUNNER_INTERNAL_URL}/`)
        ? input
        : `${RUNNER_INTERNAL_URL}${input.startsWith('/') ? '' : '/'}${input}`;
      const request = new Request(url, init);
      return handleBackupTransferRequest(env, request, createDatabaseJobLease(env.DB));
    },
  };
}

/** Resolve the runner implementation from whatever the current platform provides. */
export function getBackupRunner(env: Env): BackupRunnerPort {
  if (env.BACKUP_TRANSFER_RUNNER) return createDurableObjectBackupRunner(env.BACKUP_TRANSFER_RUNNER);
  return createInlineBackupRunner(env);
}
