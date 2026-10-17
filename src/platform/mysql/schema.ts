import type { SqlDatabase } from '../types';

/**
 * Hand-translated MySQL schema, mirroring src/services/storage-schema.ts
 * (SQLite/D1). Type mapping rules:
 * - `TEXT` used as PRIMARY KEY / UNIQUE / indexed column → `VARCHAR(191)`,
 *   because MySQL cannot key on unbounded TEXT (utf8mb4 × 191 ≤ 3072 bytes).
 * - Other `TEXT` (payloads, ciphertext JSON) → `LONGTEXT`.
 * - `INTEGER` (epoch-milliseconds and flags) → `BIGINT`.
 * - Timestamps remain ISO strings in `VARCHAR(64)` so lexicographic ORDER BY
 *   behaves exactly like the D1 TEXT ordering.
 *
 * Keep in sync with storage-schema.ts AND migrations/0001_init.sql.
 */
export const MYSQL_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS \`config\` (\`key\` VARCHAR(255) NOT NULL, \`value\` LONGTEXT NOT NULL, PRIMARY KEY (\`key\`))`,

  `CREATE TABLE IF NOT EXISTS \`users\` (
    \`id\` VARCHAR(191) NOT NULL,
    email VARCHAR(255) NOT NULL,
    \`name\` LONGTEXT NULL,
    master_password_hint LONGTEXT NULL,
    master_password_hash LONGTEXT NULL,
    \`key\` LONGTEXT NOT NULL,
    private_key LONGTEXT NULL,
    public_key LONGTEXT NULL,
    kdf_type BIGINT NOT NULL,
    kdf_iterations BIGINT NOT NULL,
    kdf_memory BIGINT NULL,
    kdf_parallelism BIGINT NULL,
    security_stamp LONGTEXT NOT NULL,
    \`role\` VARCHAR(32) NOT NULL DEFAULT 'user',
    \`status\` VARCHAR(32) NOT NULL DEFAULT 'active',
    verify_devices BIGINT NOT NULL DEFAULT 0,
    totp_secret LONGTEXT NULL,
    totp_recovery_code LONGTEXT NULL,
    yubikey_key1 LONGTEXT NULL,
    yubikey_key2 LONGTEXT NULL,
    yubikey_key3 LONGTEXT NULL,
    yubikey_key4 LONGTEXT NULL,
    yubikey_key5 LONGTEXT NULL,
    yubikey_nfc BIGINT NOT NULL DEFAULT 0,
    api_key LONGTEXT NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`users_email_unique\` (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS \`domain_settings\` (
    user_id VARCHAR(191) NOT NULL,
    equivalent_domains LONGTEXT NOT NULL DEFAULT ('[]'),
    custom_equivalent_domains LONGTEXT NOT NULL DEFAULT ('[]'),
    excluded_global_equivalent_domains LONGTEXT NOT NULL DEFAULT ('[]'),
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (user_id),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS \`user_revisions\` (
    user_id VARCHAR(191) NOT NULL,
    revision_date VARCHAR(64) NOT NULL,
    PRIMARY KEY (user_id),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS \`ciphers\` (
    \`id\` VARCHAR(191) NOT NULL,
    user_id VARCHAR(191) NOT NULL,
    \`type\` BIGINT NOT NULL,
    folder_id VARCHAR(191) NULL,
    \`name\` LONGTEXT NULL,
    notes LONGTEXT NULL,
    favorite BIGINT NOT NULL DEFAULT 0,
    data LONGTEXT NOT NULL,
    reprompt BIGINT NULL,
    \`key\` LONGTEXT NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    archived_at VARCHAR(64) NULL,
    deleted_at VARCHAR(64) NULL,
    PRIMARY KEY (\`id\`),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_ciphers_user_updated ON ciphers(user_id, updated_at)',
  'CREATE INDEX idx_ciphers_user_archived ON ciphers(user_id, archived_at)',
  'CREATE INDEX idx_ciphers_user_deleted ON ciphers(user_id, deleted_at)',
  'CREATE INDEX idx_ciphers_user_deleted_updated ON ciphers(user_id, deleted_at, updated_at)',
  'CREATE INDEX idx_ciphers_user_folder ON ciphers(user_id, folder_id)',

  `CREATE TABLE IF NOT EXISTS \`folders\` (
    \`id\` VARCHAR(191) NOT NULL,
    user_id VARCHAR(191) NOT NULL,
    \`name\` LONGTEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (\`id\`),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_folders_user_updated ON folders(user_id, updated_at)',

  `CREATE TABLE IF NOT EXISTS \`attachments\` (
    \`id\` VARCHAR(191) NOT NULL,
    cipher_id VARCHAR(191) NOT NULL,
    file_name LONGTEXT NOT NULL,
    \`size\` BIGINT NOT NULL,
    size_name LONGTEXT NOT NULL,
    \`key\` LONGTEXT NULL,
    PRIMARY KEY (\`id\`),
    FOREIGN KEY (cipher_id) REFERENCES \`ciphers\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_attachments_cipher ON attachments(cipher_id)',

  `CREATE TABLE IF NOT EXISTS \`sends\` (
    \`id\` VARCHAR(191) NOT NULL,
    user_id VARCHAR(191) NOT NULL,
    \`type\` BIGINT NOT NULL,
    \`name\` LONGTEXT NOT NULL,
    notes LONGTEXT NULL,
    data LONGTEXT NOT NULL,
    \`key\` LONGTEXT NOT NULL,
    password_hash LONGTEXT NULL,
    password_salt LONGTEXT NULL,
    password_iterations BIGINT NULL,
    auth_type BIGINT NOT NULL DEFAULT 2,
    emails LONGTEXT NULL,
    max_access_count BIGINT NULL,
    access_count BIGINT NOT NULL DEFAULT 0,
    \`disabled\` BIGINT NOT NULL DEFAULT 0,
    hide_email BIGINT NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    expiration_date VARCHAR(64) NULL,
    deletion_date VARCHAR(64) NOT NULL,
    PRIMARY KEY (\`id\`),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_sends_user_updated ON sends(user_id, updated_at)',
  'CREATE INDEX idx_sends_user_deletion ON sends(user_id, deletion_date)',
  'CREATE INDEX idx_sends_user_updated_id ON sends(user_id, updated_at, id)',

  `CREATE TABLE IF NOT EXISTS \`refresh_tokens\` (
    \`token\` VARCHAR(255) NOT NULL,
    user_id VARCHAR(191) NOT NULL,
    expires_at BIGINT NOT NULL,
    device_identifier VARCHAR(191) NULL,
    device_session_stamp LONGTEXT NULL,
    security_stamp LONGTEXT NULL,
    created_at BIGINT NULL,
    last_used_at BIGINT NULL,
    absolute_expires_at BIGINT NULL,
    client_type LONGTEXT NULL,
    PRIMARY KEY (\`token\`),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id)',

  `CREATE TABLE IF NOT EXISTS \`invites\` (
    \`code\` VARCHAR(191) NOT NULL,
    created_by VARCHAR(191) NOT NULL,
    used_by VARCHAR(191) NULL,
    expires_at VARCHAR(64) NOT NULL,
    \`status\` VARCHAR(32) NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (\`code\`),
    FOREIGN KEY (created_by) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE,
    FOREIGN KEY (used_by) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_invites_status_expires ON invites(status, expires_at)',
  'CREATE INDEX idx_invites_created_by ON invites(created_by, created_at)',

  `CREATE TABLE IF NOT EXISTS \`audit_logs\` (
    \`id\` VARCHAR(191) NOT NULL,
    actor_user_id VARCHAR(191) NULL,
    \`action\` LONGTEXT NOT NULL,
    \`category\` VARCHAR(32) NOT NULL DEFAULT 'system',
    \`level\` VARCHAR(32) NOT NULL DEFAULT 'info',
    target_type LONGTEXT NULL,
    target_id VARCHAR(191) NULL,
    metadata LONGTEXT NULL,
    created_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (\`id\`),
    FOREIGN KEY (actor_user_id) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at)',
  'CREATE INDEX idx_audit_logs_actor_created ON audit_logs(actor_user_id, created_at)',
  'CREATE INDEX idx_audit_logs_category_created ON audit_logs(category, created_at)',
  'CREATE INDEX idx_audit_logs_level_created ON audit_logs(level, created_at)',

  `CREATE TABLE IF NOT EXISTS \`devices\` (
    user_id VARCHAR(191) NOT NULL,
    device_identifier VARCHAR(191) NOT NULL,
    \`name\` LONGTEXT NOT NULL,
    \`type\` BIGINT NOT NULL,
    session_stamp LONGTEXT NULL,
    encrypted_user_key LONGTEXT NULL,
    encrypted_public_key LONGTEXT NULL,
    encrypted_private_key LONGTEXT NULL,
    push_uuid LONGTEXT NULL,
    push_token LONGTEXT NULL,
    banned BIGINT NOT NULL DEFAULT 0,
    banned_at VARCHAR(64) NULL,
    device_note LONGTEXT NULL,
    last_seen_at VARCHAR(64) NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (user_id, device_identifier),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_devices_user_updated ON devices(user_id, updated_at)',
  'CREATE INDEX idx_devices_user_last_seen ON devices(user_id, last_seen_at)',
  'CREATE INDEX idx_devices_user_push ON devices(user_id, push_token(255))',
  "UPDATE refresh_tokens SET device_session_stamp = (SELECT devices.session_stamp FROM devices WHERE devices.user_id = refresh_tokens.user_id AND devices.device_identifier = refresh_tokens.device_identifier) WHERE device_identifier IS NOT NULL AND (device_session_stamp IS NULL OR device_session_stamp = '') AND EXISTS (SELECT 1 FROM devices WHERE devices.user_id = refresh_tokens.user_id AND devices.device_identifier = refresh_tokens.device_identifier)",
  "UPDATE refresh_tokens SET client_type = CASE WHEN EXISTS (SELECT 1 FROM devices WHERE devices.user_id = refresh_tokens.user_id AND devices.device_identifier = refresh_tokens.device_identifier AND devices.type IN (0, 1)) THEN 'mobile' WHEN EXISTS (SELECT 1 FROM devices WHERE devices.user_id = refresh_tokens.user_id AND devices.device_identifier = refresh_tokens.device_identifier AND devices.type = 14) THEN 'web' ELSE 'other' END WHERE client_type IS NULL OR client_type = ''",

  `CREATE TABLE IF NOT EXISTS \`auth_requests\` (
    \`id\` VARCHAR(191) NOT NULL,
    user_id VARCHAR(191) NOT NULL,
    organization_id VARCHAR(191) NULL,
    \`type\` BIGINT NOT NULL,
    request_device_identifier VARCHAR(191) NOT NULL,
    request_device_type BIGINT NOT NULL,
    request_ip_address VARCHAR(64) NULL,
    request_country_name VARCHAR(255) NULL,
    response_device_identifier VARCHAR(191) NULL,
    access_code LONGTEXT NOT NULL,
    public_key LONGTEXT NOT NULL,
    \`key\` LONGTEXT NULL,
    master_password_hash LONGTEXT NULL,
    approved BIGINT NULL,
    creation_date VARCHAR(64) NOT NULL,
    response_date VARCHAR(64) NULL,
    authentication_date VARCHAR(64) NULL,
    PRIMARY KEY (\`id\`),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_auth_requests_user_created ON auth_requests(user_id, creation_date)',
  'CREATE INDEX idx_auth_requests_user_pending ON auth_requests(user_id, approved, response_date, authentication_date, creation_date)',
  'CREATE INDEX idx_auth_requests_device_pending ON auth_requests(user_id, request_device_identifier, creation_date)',

  `CREATE TABLE IF NOT EXISTS \`trusted_two_factor_device_tokens\` (
    \`token\` VARCHAR(255) NOT NULL,
    user_id VARCHAR(191) NOT NULL,
    device_identifier VARCHAR(191) NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (\`token\`),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_trusted_two_factor_device_tokens_user_device ON trusted_two_factor_device_tokens(user_id, device_identifier)',

  `CREATE TABLE IF NOT EXISTS \`totp_login_replays\` (
    user_id VARCHAR(191) NOT NULL,
    time_counter BIGINT NOT NULL,
    consumed_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, time_counter),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_totp_login_replays_consumed_at ON totp_login_replays(consumed_at)',

  `CREATE TABLE IF NOT EXISTS \`webauthn_credentials\` (
    \`id\` VARCHAR(191) NOT NULL,
    user_id VARCHAR(191) NOT NULL,
    purpose VARCHAR(64) NOT NULL DEFAULT 'login',
    \`name\` LONGTEXT NOT NULL,
    public_key LONGTEXT NOT NULL,
    credential_id LONGTEXT NOT NULL,
    \`counter\` BIGINT NOT NULL DEFAULT 0,
    \`type\` LONGTEXT NULL,
    aa_guid LONGTEXT NULL,
    transports LONGTEXT NULL,
    encrypted_user_key LONGTEXT NULL,
    encrypted_public_key LONGTEXT NULL,
    encrypted_private_key LONGTEXT NULL,
    supports_prf BIGINT NOT NULL DEFAULT 0,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (\`id\`),
    FOREIGN KEY (user_id) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE UNIQUE INDEX idx_webauthn_credentials_credential_id ON webauthn_credentials(credential_id(255))',
  'CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id)',
  'CREATE INDEX idx_webauthn_credentials_user_updated ON webauthn_credentials(user_id, updated_at)',

  `CREATE TABLE IF NOT EXISTS \`webauthn_challenges\` (
    challenge_hash VARCHAR(191) NOT NULL,
    \`scope\` LONGTEXT NOT NULL,
    user_id VARCHAR(191) NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (challenge_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at)',
  'CREATE INDEX idx_webauthn_challenges_user_scope ON webauthn_challenges(user_id, scope(255))',

  `CREATE TABLE IF NOT EXISTS \`login_attempts_ip\` (
    ip VARCHAR(191) NOT NULL,
    attempts BIGINT NOT NULL,
    locked_until BIGINT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (ip)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS \`used_attachment_download_tokens\` (
    \`jti\` VARCHAR(255) NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (\`jti\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/**
 * MySQL-side schema bootstrap. Idempotence matches the D1 flow: errors that
 * mean "already exists / duplicate column" are swallowed so re-running on an
 * existing database is safe.
 */
export async function ensureMysqlStorageSchema(db: SqlDatabase): Promise<void> {
  for (const statement of MYSQL_SCHEMA_STATEMENTS) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      // MySQL has no CREATE INDEX IF NOT EXISTS; re-runs surface an existing
      // index as "duplicate key name" — treat it like the sqlite-side
      // 'already exists' tolerance for schema idempotency.
      if (msg.includes('already exists') || msg.includes('duplicate column name') || msg.includes('duplicate key name')) continue;
      throw error;
    }
  }
}
