import { constantTimeEquals } from '../utils/api-key';

// This is the server's second layer; the client performs its own KDF first.
const ITERATIONS = 100_000;
const LEGACY_PREFIX = '$s$';
const PREFIX = '$s2$';
const SALT_BYTES = 32;
const DUMMY_SALT = new Uint8Array(SALT_BYTES);
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;
// main2 wrote `$s$<salt_b64>$<hash_b64>` with a 16-byte salt before this module
// existed. Those rows are still in the database, so verification has to accept
// that layout and keep paying the same PBKDF2 cost.
const SALT_16_BYTES = 16;
const BASE64_16_BYTES = /^[A-Za-z0-9+/]{22}==$/;

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decode32Bytes(value: string): Uint8Array | null {
  if (!BASE64_32_BYTES.test(value)) return null;
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  return bytes.length === SALT_BYTES && toBase64(bytes) === value ? bytes : null;
}

function decode16Bytes(value: string): Uint8Array | null {
  if (!BASE64_16_BYTES.test(value)) return null;
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  return bytes.length === SALT_16_BYTES && toBase64(bytes) === value ? bytes : null;
}

// main2 stored `$s$<salt_b64>$<hash_b64>`: a 16-byte salt followed by the
// digest, with no version or work-factor field. Recognise it so existing
// accounts keep verifying after the migration to this module.
function parseLegacySaltedVerifier(stored: string): { salt: Uint8Array; digest: string } | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 's') return null;
  const salt = decode16Bytes(parts[2]);
  if (!salt || !decode32Bytes(parts[3])) return null;
  return { salt, digest: parts[3] };
}

function parseVerifier(stored: string): { salt: Uint8Array; digest: string } | null {
  const parts = stored.split('$');
  // Accept only the work factor this version writes, keeping verification work
  // equivalent and preventing corrupt/imported rows from requesting arbitrary work.
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 's2' || parts[2] !== String(ITERATIONS)) return null;
  const salt = decode32Bytes(parts[3]);
  if (!salt || !decode32Bytes(parts[4])) return null;
  return { salt, digest: parts[4] };
}

async function deriveDigest(clientHash: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(clientHash), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256
  );
  return toBase64(new Uint8Array(bits));
}

export async function createPasswordVerifier(clientHash: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const digest = await deriveDigest(clientHash, salt);
  // Self-contained version, work factor, salt and digest; no schema change.
  return `${PREFIX}${ITERATIONS}$${toBase64(salt)}$${digest}`;
}

export async function performDummyPasswordWork(clientHash: string): Promise<void> {
  // The result is discarded and can never authenticate anyone. The salt need
  // not be random here; no password verifier is being stored.
  await deriveDigest(clientHash, DUMMY_SALT);
}

export async function verifyPasswordVerifier(
  clientHash: string,
  stored: string | null,
  email: string
): Promise<boolean> {
  const verifier = stored?.startsWith(PREFIX) ? parseVerifier(stored) : null;
  if (verifier) {
    return constantTimeEquals(await deriveDigest(clientHash, verifier.salt), verifier.digest);
  }
  if (stored?.startsWith(LEGACY_PREFIX)) {
    const legacySalted = parseLegacySaltedVerifier(stored);
    if (legacySalted) {
      return constantTimeEquals(await deriveDigest(clientHash, legacySalted.salt), legacySalted.digest);
    }
    if (decode32Bytes(stored.slice(LEGACY_PREFIX.length))) {
      const digest = await deriveDigest(clientHash, new TextEncoder().encode(email.toLowerCase().trim()));
      return constantTimeEquals(`${LEGACY_PREFIX}${digest}`, stored);
    }
  }

  // Missing users, raw legacy verifiers and malformed/unknown formats all pay
  // the same PBKDF2 cost. Reserved formats must never fall back to raw equality.
  await performDummyPasswordWork(clientHash);
  return !!stored && !stored.startsWith('$') && constantTimeEquals(clientHash, stored);
}

export function needsPasswordVerifierUpgrade(stored: string): boolean {
  if (stored.startsWith(PREFIX)) return needsUpgradeWithinS2(stored);
  // main2's `$s$<salt>$<hash>` rows predate this module and must be rehashed.
  return stored.startsWith(LEGACY_PREFIX) || !stored.startsWith('$');
}

function needsUpgradeWithinS2(stored: string): boolean {
  return !parseVerifier(stored);
}
