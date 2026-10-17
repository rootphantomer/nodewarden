import type { Env } from '../types';
import type { JobLease } from '../services/job-lease';
import { handleBackupTransferRequest } from '../handlers/backup-transfer-dispatch';

/**
 * Cloudflare Durable Object for backup transfer jobs.
 *
 * The object contributes exactly one platform capability — a strongly
 * serialized job lease in DO storage — while all endpoint logic lives in
 * the platform-neutral dispatcher (handlers/backup-transfer-dispatch.ts),
 * which non-Cloudflare targets reuse with a config-row CAS lease.
 */

const BACKUP_JOB_STATE_KEY = 'backup.job.state.v1';
const BACKUP_JOB_LEASE_MS = 10 * 60 * 1000;
const BACKUP_JOB_HEARTBEAT_MS = 30 * 1000;

interface BackupJobState {
  token: string;
  reason: string;
  acquiredAt: string;
  touchedAt: string;
  expiresAtMs: number;
}

export class BackupTransferRunner {
  private lastHeartbeatAt = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
  }

  private async acquireJob(reason: string): Promise<string | null> {
    const nowMs = Date.now();
    const current = await this.state.storage.get<BackupJobState>(BACKUP_JOB_STATE_KEY);
    if (current?.expiresAtMs && current.expiresAtMs > nowMs) {
      return null;
    }

    const token = crypto.randomUUID();
    const nowIso = new Date(nowMs).toISOString();
    await this.state.storage.put<BackupJobState>(BACKUP_JOB_STATE_KEY, {
      token,
      reason,
      acquiredAt: nowIso,
      touchedAt: nowIso,
      expiresAtMs: nowMs + BACKUP_JOB_LEASE_MS,
    });
    this.lastHeartbeatAt = 0;
    return token;
  }

  private async touchJob(token: string): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastHeartbeatAt < BACKUP_JOB_HEARTBEAT_MS) return;
    this.lastHeartbeatAt = nowMs;

    const current = await this.state.storage.get<BackupJobState>(BACKUP_JOB_STATE_KEY);
    if (current?.token !== token) return;

    await this.state.storage.put<BackupJobState>(BACKUP_JOB_STATE_KEY, {
      ...current,
      touchedAt: new Date(nowMs).toISOString(),
      expiresAtMs: nowMs + BACKUP_JOB_LEASE_MS,
    });
  }

  private async releaseJob(token: string): Promise<void> {
    const current = await this.state.storage.get<BackupJobState>(BACKUP_JOB_STATE_KEY);
    if (current?.token === token) {
      await this.state.storage.delete(BACKUP_JOB_STATE_KEY);
    }
  }

  private lease(): JobLease {
    return {
      acquire: (reason) => this.acquireJob(reason),
      touch: (token) => this.touchJob(token),
      release: (token) => this.releaseJob(token),
    };
  }

  async fetch(request: Request): Promise<Response> {
    return handleBackupTransferRequest(this.env, request, this.lease());
  }
}
