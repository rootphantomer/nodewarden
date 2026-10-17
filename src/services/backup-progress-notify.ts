import type { Env } from '../types';

/**
 * Backup-progress broadcasts, expressed directly over the optional
 * `NOTIFICATIONS_HUB` namespace port so that non-Cloudflare targets skip
 * them cleanly (namespace absent → silent no-op). Kept out of
 * durable/notifications-hub.ts so handlers can import this module without
 * pulling `cloudflare:workers` into platform-neutral bundles.
 */

const SIGNALR_UPDATE_TYPE_BACKUP_RESTORE_PROGRESS = 102;

function getHubBroadcastNamespace(env: Env): NonNullable<Env['NOTIFICATIONS_HUB']> | null {
  return env.NOTIFICATIONS_HUB ?? null;
}

export async function notifyUserBackupProgress(
  env: Env,
  userId: string,
  progress: {
    operation: 'backup-restore' | 'backup-export' | 'backup-remote-run';
    source?: 'local' | 'remote';
    step: string;
    fileName: string;
    stageTitle?: string;
    stageDetail?: string;
    replaceExisting?: boolean;
    done?: boolean;
    ok?: boolean;
    error?: string | null;
    timestamp?: string;
  },
  targetDeviceIdentifier?: string | null
): Promise<void> {
  const revisionDate = progress.timestamp || new Date().toISOString();
  try {
    const hub = getHubBroadcastNamespace(env);
    if (!hub) return;
    const id = hub.idFromName(userId);
    const stub = hub.get(id);
    await stub.fetch('https://notifications/internal/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NodeWarden-UserId': userId,
      },
      body: JSON.stringify({
        revisionDate,
        contextId: null,
        updateType: SIGNALR_UPDATE_TYPE_BACKUP_RESTORE_PROGRESS,
        targetDeviceIdentifier: targetDeviceIdentifier || null,
        payload: {
          UserId: userId,
          Date: revisionDate,
          ...progress,
        },
      }),
    });
  } catch (error) {
    console.error('Failed to broadcast backup progress:', error);
  }
}

export function notifyUserBackupRestoreProgress(
  env: Env,
  userId: string,
  progress: {
    operation: 'backup-restore';
    source: 'local' | 'remote';
    step: string;
    fileName: string;
    stageTitle?: string;
    stageDetail?: string;
    replaceExisting?: boolean;
    done?: boolean;
    ok?: boolean;
    error?: string | null;
    timestamp?: string;
  },
  targetDeviceIdentifier?: string | null
): Promise<void> {
  return notifyUserBackupProgress(env, userId, progress, targetDeviceIdentifier);
}
