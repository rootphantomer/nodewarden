import type { PlatformBlobBackend } from '../types';

/**
 * EdgeOne Makers Blob adapter (@edgeone/pages-blob SDK), surfaced as a
 * `PlatformBlobBackend` that main-edgeone.ts injects as `Env.ATTACHMENTS_BLOB`.
 * blob-store.ts then consults it as the lowest-priority backend after the
 * Cloudflare R2/KV bindings, keeping a single key layout and code path.
 *
 * The SDK is loaded lazily: the module only exists inside the EdgeOne
 * runtime, so builds and tests never evaluate it until the first
 * attachment operation. Reads use strong consistency — attachment content
 * must be visible immediately after write (the same-fetch read pattern).
 */
export function createEdgeOneBlobBackend(storeName: string): PlatformBlobBackend {
  return {
    async set(key, value, meta): Promise<void> {
      const store = await getStore(storeName);
      await store.set(key, value, {
        'content-type': meta.contentType || 'application/octet-stream',
      });
    },

    async getArrayBuffer(key): Promise<ArrayBuffer | null> {
      const store = await getStore(storeName);
      const bytes = await store.get(key, { type: 'arrayBuffer', consistency: 'strong' });
      return (bytes as ArrayBuffer | null) ?? null;
    },

    async getMetadataHeaders(key): Promise<Record<string, string> | null> {
      const store = await getStore(storeName);
      const withHeaders = await store.getWithHeaders(key, { consistency: 'strong' });
      if (!withHeaders) return null;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(withHeaders.headers || {})) {
        headers[String(k).toLowerCase()] = String(v);
      }
      return headers;
    },

    async delete(key): Promise<void> {
      const store = await getStore(storeName);
      await store.delete(key);
    },
  };
}

async function getStore(storeName: string): Promise<any> {
  const moduleName = '@edgeone/pages-blob';
  // Deliberately dynamic: keeps the SDK out of the Cloudflare bundle and
  // out of test runs (it only resolves inside the EdgeOne runtime).
  const sdk = await import(/* @vite-ignore */ moduleName);
  return sdk.getStore(storeName);
}
