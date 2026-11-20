import { User, UserDecryptionOptions, WebAuthnPrfDecryptionOption } from '../types';

function normalizeOptionalPublicKey(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

export function buildAccountKeys(user: Pick<User, 'privateKey' | 'publicKey'>): Record<string, unknown> | null {
  if (!user.privateKey) {
    return null;
  }

  const publicKey = normalizeOptionalPublicKey(user.publicKey);

  return {
    publicKeyEncryptionKeyPair: {
      wrappedPrivateKey: user.privateKey,
      publicKey,
      signedPublicKey: null,
      object: 'publicKeyEncryptionKeyPair',
      Object: 'publicKeyEncryptionKeyPair',
    },
    securityState: null,
    signatureKeyPair: null,
    object: 'privateKeys',
    Object: 'privateKeys',
  };
}

export function buildMasterPasswordUnlock(
  user: Pick<User, 'email' | 'key' | 'kdfType' | 'kdfIterations' | 'kdfMemory' | 'kdfParallelism'>
): UserDecryptionOptions['MasterPasswordUnlock'] {
  return {
    Kdf: {
      KdfType: user.kdfType,
      Iterations: user.kdfIterations,
      Memory: user.kdfMemory ?? null,
      Parallelism: user.kdfParallelism ?? null,
    },
    MasterKeyEncryptedUserKey: user.key,
    MasterKeyWrappedUserKey: user.key,
    Salt: user.email.toLowerCase(),
    Object: 'masterPasswordUnlock',
  };
}

export function buildUserDecryptionOptions(
  user: Pick<User, 'email' | 'key' | 'kdfType' | 'kdfIterations' | 'kdfMemory' | 'kdfParallelism'>,
  webAuthnPrfOption: WebAuthnPrfDecryptionOption | null = null
): UserDecryptionOptions {
  return {
    HasMasterPassword: true,
    Object: 'userDecryptionOptions',
    MasterPasswordUnlock: buildMasterPasswordUnlock(user),
    TrustedDeviceOption: null,
    KeyConnectorOption: null,
    WebAuthnPrfOption: webAuthnPrfOption,
  };
}

function toCompatWebAuthnPrfOption(option: WebAuthnPrfDecryptionOption): Record<string, unknown> {
  const source = option as unknown as Record<string, unknown>;
  return {
    encryptedPrivateKey: source.EncryptedPrivateKey ?? source.encryptedPrivateKey ?? null,
    encryptedUserKey: source.EncryptedUserKey ?? source.encryptedUserKey ?? null,
    credentialId: source.CredentialId ?? source.credentialId ?? null,
    transports: source.Transports ?? source.transports ?? [],
    object: 'webAuthnPrfDecryptionOption',
  };
}

// camelCase mirror of the PascalCase `UserDecryption` payload. Both spellings are
// emitted for client compatibility, so they must carry the same data: a
// case-sensitive client reading `userDecryption` would otherwise lose the
// WebAuthn PRF unlock options and the user key id.
export function buildUserDecryptionCompat(
  user: Pick<User, 'email' | 'key' | 'kdfType' | 'kdfIterations' | 'kdfMemory' | 'kdfParallelism'>,
  webAuthnPrfOptions: WebAuthnPrfDecryptionOption[] = [],
  userKeyId: string | null = null
): Record<string, unknown> {
  const prfOptions = webAuthnPrfOptions.map(toCompatWebAuthnPrfOption);
  return {
    masterPasswordUnlock: {
      kdf: {
        kdfType: user.kdfType,
        iterations: user.kdfIterations,
        memory: user.kdfMemory ?? null,
        parallelism: user.kdfParallelism ?? null,
      },
      masterKeyWrappedUserKey: user.key,
      masterKeyEncryptedUserKey: user.key,
      salt: user.email.toLowerCase(),
      object: 'masterPasswordUnlock',
    },
    trustedDeviceOption: null,
    keyConnectorOption: null,
    webAuthnPrfOption: prfOptions[0] ?? null,
    webAuthnPrfOptions: prfOptions,
    v2UpgradeToken: null,
    userKeyId,
    object: 'userDecryption',
  };
}
