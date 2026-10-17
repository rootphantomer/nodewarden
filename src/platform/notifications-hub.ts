import type { Env } from '../types';
import { verifyWebSocketConnectionToken } from '../utils/websocket-connection-token';
import type { ConnectionTicketIdentity, NotificationsHubPort } from './types';

const NOTIFICATIONS_INTERNAL_ORIGIN = 'https://notifications/internal';
const DEGRADED_HUB_UPGRADE_MESSAGE =
  'Realtime push is unavailable on this platform; clients fall back to revision-date polling';

/**
 * Cloudflare default: everything is forwarded to the `NotificationsHub`
 * Durable Object through the same internal fetch API the pre-refactor
 * handlers used, so behavior and the test contract stay identical.
 */
export function createDurableObjectNotificationsHub(
  namespace: NonNullable<Env['NOTIFICATIONS_HUB']>
): NotificationsHubPort {
  return {
    async registerConnectionTicket(input): Promise<void> {
      const id = namespace.idFromName(input.userId);
      const stub = namespace.get(id);
      const response = await stub.fetch(`${NOTIFICATIONS_INTERNAL_ORIGIN}/ws-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error('Failed to issue websocket connection token');
    },

    async consumeConnectionTicket(token, routingUserId): Promise<ConnectionTicketIdentity | null> {
      // The signed routing claim selects the object; previously an attacker
      // could otherwise activate arbitrary object names with forged prefixes.
      const id = namespace.idFromName(routingUserId);
      const stub = namespace.get(id);
      const response = await stub.fetch(`${NOTIFICATIONS_INTERNAL_ORIGIN}/ws-token/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) return null;

      const connection = (await response.json().catch(() => null)) as ConnectionTicketIdentity | null;
      if (!connection || connection.userId !== routingUserId) return null;
      return connection;
    },

    connect(request, identity): Promise<Response> {
      const forwardedUrl = new URL(request.url);
      if ('userId' in identity) {
        forwardedUrl.searchParams.set('nw_uid', identity.userId);
        if (identity.deviceIdentifier) {
          forwardedUrl.searchParams.set('nw_did', identity.deviceIdentifier);
        }
      } else {
        forwardedUrl.searchParams.set('nw_auth_request_id', identity.authRequestId);
      }
      const id = namespace.idFromName('userId' in identity ? identity.userId : identity.authRequestId);
      const stub = namespace.get(id);
      return stub.fetch(new Request(forwardedUrl.toString(), request));
    },
  };
}

/**
 * Degraded default for platforms without singleton stateful workers
 * (Tencent EdgeOne Makers, Aliyun FC HTTP functions...).
 *
 * - Tickets keep their HMAC signature and 60&nbsp;s TTL, but are not stored, so
 *   the DO's atomic single-use consumption cannot be enforced. This trades a
 *   narrow replay window for compatibility; the ticket is signed with
 *   JWT_SECRET and scoped to `notifications.websocket` only.
 * - Websocket upgrades are rejected with 501; Bitwarden clients continue to
 *   sync periodically via `/api/accounts/revision-date`.
 */
export function createDegradedNotificationsHub(env: Env): NotificationsHubPort {
  return {
    async registerConnectionTicket(): Promise<void> {
      // No hub storage exists; consumption relies on ticket signature + TTL.
    },

    async consumeConnectionTicket(token, routingUserId): Promise<ConnectionTicketIdentity | null> {
      const claims = await verifyWebSocketConnectionToken(token, env.JWT_SECRET);
      if (!claims || claims.userId !== routingUserId) return null;
      return { userId: claims.userId, deviceIdentifier: null };
    },

    async connect(): Promise<Response> {
      return new Response(JSON.stringify({ error: DEGRADED_HUB_UPGRADE_MESSAGE }), {
        status: 501,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    },
  };
}

/** Resolve the hub implementation from whatever the current platform provides. */
export function getNotificationsHub(env: Env): NotificationsHubPort {
  if (env.NOTIFICATIONS_HUB) return createDurableObjectNotificationsHub(env.NOTIFICATIONS_HUB);
  return createDegradedNotificationsHub(env);
}
