/**
 * Bundling shim for the `cloudflare:workers` module import that survives in
 * the platform-neutral dependency graph (src/durable/notifications-hub.ts
 * declares the DurableObject base class). EdgeOne Makers and local Node
 * builds never instantiate Durable Objects — the platform layer degrades
 * before any DO code path runs — so an empty base class and a no-op
 * `waitUntil` are safe stand-ins. Cloudflare builds keep the real module.
 */
export class DurableObject {}
export function waitUntil(promise: Promise<unknown>): void {
  promise.catch(() => {});
}
