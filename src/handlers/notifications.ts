import { AuthService } from '../services/auth';
import { StorageService } from '../services/storage';
import { isAuthRequestExpired } from '../services/storage-auth-request-repo';
import type { Env, JWTPayload } from '../types';
import { errorResponse, jsonResponse } from '../utils/response';
import { generateUUID } from '../utils/uuid';
import { getNotificationsHub } from '../platform';
import {
  createWebSocketConnectionToken,
  verifyWebSocketConnectionToken,
} from '../utils/websocket-connection-token';

const WEBSOCKET_CONNECTION_TOKEN_TTL_MS = 60 * 1000;

function extractAccessToken(request: Request): string | null {
  const authHeader = String(request.headers.get('Authorization') || '').trim();
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function authenticateAccessToken(request: Request, env: Env): Promise<JWTPayload | null> {
  const accessToken = extractAccessToken(request);
  if (!accessToken) return null;

  const auth = new AuthService(env);
  return auth.verifyAccessToken(`Bearer ${accessToken}`);
}

async function issueWebSocketConnectionToken(payload: JWTPayload, env: Env): Promise<string> {
  const expiresAt = Date.now() + WEBSOCKET_CONNECTION_TOKEN_TTL_MS;
  const token = await createWebSocketConnectionToken(payload.sub, expiresAt, env.JWT_SECRET);
  const hub = getNotificationsHub(env);
  await hub.registerConnectionTicket({
    token,
    userId: payload.sub,
    deviceIdentifier: payload.did || null,
    expiresAt,
  });
  return token;
}

async function consumeWebSocketConnectionToken(request: Request, env: Env): Promise<JWTPayload | null> {
  const token = String(new URL(request.url).searchParams.get('id') || '').trim();
  const claims = await verifyWebSocketConnectionToken(token, env.JWT_SECRET);
  if (!claims) return null;

  const hub = getNotificationsHub(env);
  const connection = await hub.consumeConnectionTicket(token, claims.userId);
  if (!connection) return null;

  return {
    sub: connection.userId,
    did: String(connection.deviceIdentifier || '').trim() || undefined,
  } as JWTPayload;
}

async function authenticateNotificationsHub(request: Request, env: Env): Promise<JWTPayload | null> {
  // Never accept an access JWT from the URL: URLs are routinely retained by logs,
  // browser history, proxies, monitoring, and error tracking systems.
  if (request.headers.has('Authorization')) {
    return authenticateAccessToken(request, env);
  }
  return consumeWebSocketConnectionToken(request, env);
}

export async function handleNotificationsNegotiate(request: Request, env: Env): Promise<Response> {
  const payload = await authenticateAccessToken(request, env);
  if (!payload?.sub) return errorResponse('Unauthorized', 401);

  const connectionToken = await issueWebSocketConnectionToken(payload, env);
  return jsonResponse(
    {
      connectionId: generateUUID(),
      connectionToken,
      negotiateVersion: 1,
      availableTransports: [
        {
          transport: 'WebSockets',
          transferFormats: ['Text', 'Binary'],
        },
      ],
    },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

export async function handleNotificationsHub(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return errorResponse('Expected websocket', 426);
  }
  const payload = await authenticateNotificationsHub(request, env);
  if (!payload?.sub) return errorResponse('Unauthorized', 401);

  const userId = payload.sub;
  const hub = getNotificationsHub(env);
  return hub.connect(request, { userId, deviceIdentifier: payload.did });
}

export async function handleAnonymousNotificationsHub(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const authRequestId = String(url.searchParams.get('Token') || url.searchParams.get('token') || '').trim();
  if (!authRequestId) return errorResponse('Token is required', 400);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return errorResponse('Expected websocket', 426);
  }

  const storage = new StorageService(env.DB);
  const authRequest = await storage.getAuthRequestById(authRequestId);
  if (!authRequest || isAuthRequestExpired(authRequest)) {
    return errorResponse('Not found', 404);
  }

  const hub = getNotificationsHub(env);
  return hub.connect(request, { authRequestId });
}
