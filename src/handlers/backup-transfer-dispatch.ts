import type { Env } from '../types';
import type { JobLease } from '../services/job-lease';
import type { BackupDestinationRecord } from '../services/backup-config';
import {
  BACKUP_SCHEDULER_WINDOW_MINUTES,
  requireBackupDestination,
  hasBackupSlotBetween,
  isBackupDueNow,
  loadBackupSettings,
} from '../services/backup-config';
import {
  createRemoteBackupTransferSession,
  downloadRemoteBackupFile,
  ensureRemoteRestoreCandidate,
} from '../services/backup-uploader';
import { getBlobObject } from '../services/blob-store';
import { StorageService } from '../services/storage';
import { notifyUserBackupProgress, notifyUserBackupRestoreProgress } from '../services/backup-progress-notify';
import {
  executeConfiguredBackup,
  importAndAuditRemoteBackupFile,
} from './backup';
import { isSafeBackupAttachmentBlobName, verifyBackupArchiveFileNameChecksum } from '../services/backup-archive';
import { zipSync } from 'fflate';

/**
 * Platform-neutral implementation of the BackupTransferRunner internal API
 * (the `/internal/*` endpoints of durable/backup-transfer-runner.ts).
 *
 * Cloudflare routes the Durable Object's `fetch()` here with its DO-storage
 * lease; other platforms (EdgeOne) run the same dispatch inline with a
 * config-row CAS lease from services/job-lease.ts.
 */

interface ConfiguredBackupRunRequest {
  actorUserId?: string | null;
  auditMetadata?: Record<string, unknown> | null;
  destinationId?: string | null;
  targetDeviceIdentifier?: string | null;
  trigger?: 'manual' | 'scheduled';
}

interface RemoteBackupRestoreRequest {
  actorUserId?: string | null;
  allowChecksumMismatch?: boolean;
  auditMetadata?: Record<string, unknown> | null;
  destinationId?: string | null;
  path?: string | null;
  replaceExisting?: boolean;
  targetDeviceIdentifier?: string | null;
}

interface RemoteAttachmentChunkRequest {
  destination: BackupDestinationRecord;
  attachments: Array<{
    blobName: string;
  }>;
}

interface RemoteAttachmentDownloadRequest {
  destination: BackupDestinationRecord;
  blobName?: string | null;
}

interface RemoteAttachmentBatchDownloadRequest {
  destination: BackupDestinationRecord;
  blobNames?: string[] | null;
}

export function backupTransferBadRequest(message: string, status: number = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function backupTransferJson(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function runConfiguredBackup(env: Env, request: Request, lease: JobLease): Promise<Response> {
  let body: ConfiguredBackupRunRequest;
  try {
    body = await request.json<ConfiguredBackupRunRequest>();
  } catch {
    return backupTransferBadRequest('Backup run payload is invalid');
  }

  const trigger = body.trigger === 'scheduled' ? 'scheduled' : 'manual';
  const actorUserId = String(body.actorUserId || '').trim() || null;
  if (trigger === 'manual' && !actorUserId) {
    return backupTransferBadRequest('Manual backup run requires an actor');
  }

  const token = await lease.acquire(`${trigger}:${actorUserId || 'system'}`);
  if (!token) {
    return backupTransferBadRequest('Another backup run is already in progress', 409);
  }

  try {
    await lease.touch(token);
    const storage = new StorageService(env.DB);
    const progress = actorUserId
      ? async (event: {
        operation: 'backup-remote-run';
        step: string;
        fileName: string;
        stageTitle: string;
        stageDetail: string;
        done?: boolean;
        ok?: boolean;
        error?: string | null;
      }) => {
        await notifyUserBackupProgress(
          env,
          actorUserId,
          event,
          String(body.targetDeviceIdentifier || '').trim() || null
        );
      }
      : null;

    const result = await executeConfiguredBackup(
      env,
      storage,
      actorUserId,
      trigger,
      body.destinationId || null,
      () => lease.touch(token),
      progress,
      body.auditMetadata || null
    );
    const settings = await loadBackupSettings(storage, env, 'UTC');

    return backupTransferJson({
      object: 'backup-runner-result',
      result,
      settings,
    });
  } catch (error) {
    return backupTransferBadRequest(error instanceof Error ? error.message : 'Backup run failed', 500);
  } finally {
    await lease.release(token);
  }
}

async function runScheduledBackups(env: Env, lease: JobLease): Promise<Response> {
  const token = await lease.acquire('scheduled');
  if (!token) {
    return backupTransferBadRequest('Another backup run is already in progress', 409);
  }

  let completed = 0;
  const failures: Array<{ destinationId: string; error: string }> = [];
  try {
    await lease.touch(token);
    const storage = new StorageService(env.DB);
    let scanStartMs = Date.now();

    while (true) {
      await lease.touch(token);
      const settings = await loadBackupSettings(storage, env, 'UTC');
      const now = new Date();
      const dueDestinations = settings.destinations.filter((destination) =>
        isBackupDueNow(destination, now, BACKUP_SCHEDULER_WINDOW_MINUTES)
        || hasBackupSlotBetween(destination, new Date(scanStartMs), now)
      );

      if (!dueDestinations.length) {
        break;
      }

      scanStartMs = now.getTime();
      for (const destination of dueDestinations) {
        await lease.touch(token);
        try {
          await executeConfiguredBackup(
            env,
            storage,
            null,
            'scheduled',
            destination.id,
            () => lease.touch(token)
          );
          completed += 1;
        } catch (error) {
          failures.push({
            destinationId: destination.id,
            error: error instanceof Error ? error.message : 'Scheduled backup failed',
          });
        }
      }
    }

    return backupTransferJson({
      ok: true,
      completed,
      failed: failures.length,
      failures,
    });
  } catch (error) {
    return backupTransferBadRequest(error instanceof Error ? error.message : 'Scheduled backup failed', 500);
  } finally {
    await lease.release(token);
  }
}

async function restoreRemoteBackup(env: Env, request: Request, lease: JobLease): Promise<Response> {
  let body: RemoteBackupRestoreRequest;
  try {
    body = await request.json<RemoteBackupRestoreRequest>();
  } catch {
    return backupTransferBadRequest('Remote restore payload is invalid');
  }

  const actorUserId = String(body.actorUserId || '').trim() || null;
  if (!actorUserId) {
    return backupTransferBadRequest('Remote restore requires an actor');
  }

  const token = await lease.acquire(`restore:${actorUserId}`);
  if (!token) {
    return backupTransferBadRequest('Another backup or restore run is already in progress', 409);
  }

  try {
    await lease.touch(token);
    const storage = new StorageService(env.DB);
    const settings = await loadBackupSettings(storage, env, 'UTC');
    const destination = requireBackupDestination(settings, body.destinationId || null);
    const path = ensureRemoteRestoreCandidate(String(body.path || ''));
    const restoreFileNameFromPath = path.split('/').pop() || path;
    const targetDeviceIdentifier = String(body.targetDeviceIdentifier || '').trim() || null;
    const replaceExisting = !!body.replaceExisting;

    await notifyUserBackupRestoreProgress(
      env,
      actorUserId,
      {
        operation: 'backup-restore',
        source: 'remote',
        step: 'remote_fetch_archive',
        fileName: restoreFileNameFromPath,
        stageTitle: 'txt_backup_restore_progress_remote_fetch_title',
        stageDetail: 'txt_backup_restore_progress_remote_fetch_detail',
        replaceExisting,
      },
      targetDeviceIdentifier
    );

    const remoteFile = await downloadRemoteBackupFile(destination, path);
    const checksumOk = await verifyBackupArchiveFileNameChecksum(remoteFile.bytes, remoteFile.fileName || path);
    if (!checksumOk && !body.allowChecksumMismatch) {
      return backupTransferBadRequest('Remote backup file checksum does not match its filename');
    }

    const result = await importAndAuditRemoteBackupFile(
      env,
      storage,
      actorUserId,
      remoteFile,
      destination,
      path,
      replaceExisting,
      !checksumOk,
      body.auditMetadata || null,
      targetDeviceIdentifier,
      () => lease.touch(token)
    );

    return backupTransferJson(result.result);
  } catch (error) {
    return backupTransferBadRequest(error instanceof Error ? error.message : 'Remote backup restore failed', 500);
  } finally {
    await lease.release(token);
  }
}

async function downloadRemoteAttachment(env: Env, request: Request): Promise<Response> {
  let body: RemoteAttachmentDownloadRequest;
  try {
    body = await request.json<RemoteAttachmentDownloadRequest>();
  } catch {
    return backupTransferBadRequest('Remote attachment download payload is invalid');
  }
  const blobName = String(body?.blobName || '').trim();
  if (!body?.destination || !isSafeBackupAttachmentBlobName(blobName)) {
    return backupTransferBadRequest('Remote attachment download payload is invalid');
  }
  const file = await downloadRemoteBackupFile(body.destination, `attachments/${blobName}`).catch(() => null);
  if (!file) {
    return backupTransferBadRequest('Remote attachment not found', 404);
  }
  return new Response(file.bytes, {
    status: 200,
    headers: {
      'Content-Type': file.contentType || 'application/octet-stream',
      'Cache-Control': 'no-store',
    },
  });
}

async function downloadRemoteAttachmentBatch(_env: Env, request: Request): Promise<Response> {
  let body: RemoteAttachmentBatchDownloadRequest;
  try {
    body = await request.json<RemoteAttachmentBatchDownloadRequest>();
  } catch {
    return backupTransferBadRequest('Remote attachment batch download payload is invalid');
  }
  const blobNames = Array.from(new Set(
    (Array.isArray(body?.blobNames) ? body.blobNames : [])
      .map((blobName) => String(blobName || '').trim())
      .filter(isSafeBackupAttachmentBlobName)
  ));
  if (!body?.destination || !blobNames.length || blobNames.length > 40) {
    return backupTransferBadRequest('Remote attachment batch download payload is invalid');
  }

  const encoder = new TextEncoder();
  const entries: Array<{ blobName: string; path: string }> = [];
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < blobNames.length; i += 1) {
    const blobName = blobNames[i];
    const file = await downloadRemoteBackupFile(body.destination, `attachments/${blobName}`).catch(() => null);
    if (!file) continue;
    const path = `files/${i}.bin`;
    entries.push({ blobName, path });
    files[path] = file.bytes;
  }
  files['manifest.json'] = encoder.encode(JSON.stringify({ version: 1, entries }));

  return new Response(zipSync(files), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Cache-Control': 'no-store',
    },
  });
}

async function uploadAttachmentChunk(env: Env, request: Request): Promise<Response> {
  let body: RemoteAttachmentChunkRequest;
  try {
    body = await request.json<RemoteAttachmentChunkRequest>();
  } catch {
    return backupTransferBadRequest('Attachment chunk payload is invalid');
  }

  if (!body?.destination || !Array.isArray(body.attachments)) {
    return backupTransferBadRequest('Attachment chunk payload is invalid');
  }

  const remoteSession = createRemoteBackupTransferSession(body.destination);
  let uploaded = 0;

  for (const attachment of body.attachments) {
    const blobName = String(attachment?.blobName || '').trim();
    if (!isSafeBackupAttachmentBlobName(blobName)) {
      return backupTransferBadRequest('Attachment chunk payload is invalid');
    }

    const object = await getBlobObject(env, blobName);
    if (!object) {
      return backupTransferBadRequest(`Attachment blob missing for ${blobName}`, 409);
    }

    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    await remoteSession.putFile(`attachments/${blobName}`, bytes, {
      contentType: object.contentType,
    });
    uploaded += 1;
  }

  return backupTransferJson({
    ok: true,
    uploaded,
  });
}

export async function handleBackupTransferRequest(env: Env, request: Request, lease: JobLease): Promise<Response> {
  if (request.method !== 'POST') {
    return backupTransferBadRequest('Not found', 404);
  }
  const url = new URL(request.url);

  switch (url.pathname) {
    case '/internal/run-configured-backup':
      return runConfiguredBackup(env, request, lease);
    case '/internal/run-scheduled-backups':
      return runScheduledBackups(env, lease);
    case '/internal/restore-remote-backup':
      return restoreRemoteBackup(env, request, lease);
    case '/internal/download-remote-attachment':
      return downloadRemoteAttachment(env, request);
    case '/internal/download-remote-attachment-batch':
      return downloadRemoteAttachmentBatch(env, request);
    case '/internal/upload-attachment-chunk':
      return uploadAttachmentChunk(env, request);
    default:
      return backupTransferBadRequest('Not found', 404);
  }
}
