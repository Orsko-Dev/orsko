import { generateShortId } from "../util/ids";

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly email_verified_at: number | null;
  readonly github_id: string | null;
  readonly github_login: string | null;
  readonly display_name: string | null;
  readonly avatar_url: string | null;
  readonly plan: "free";
  readonly created_at: number;
}

const MAGIC_LINK_TTL_MS = 15 * 60_000;

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return (await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>()) ?? null;
}

export async function findUserByGithubId(
  db: D1Database,
  githubId: string,
): Promise<UserRow | null> {
  return (
    (await db.prepare("SELECT * FROM users WHERE github_id = ?").bind(githubId).first<UserRow>()) ??
    null
  );
}

export async function upsertUserByEmail(
  db: D1Database,
  input: {
    email: string;
    githubId?: string;
    githubLogin?: string;
    displayName?: string;
    avatarUrl?: string;
  },
): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  const now = Date.now();
  const id = `u_${generateShortId()}`;
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified_at, github_id, github_login, display_name, avatar_url, plan, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'free', ?)
       ON CONFLICT(email) DO UPDATE SET
         email_verified_at = COALESCE(users.email_verified_at, excluded.email_verified_at),
         github_id = COALESCE(excluded.github_id, users.github_id),
         github_login = COALESCE(excluded.github_login, users.github_login),
         display_name = COALESCE(users.display_name, excluded.display_name),
         avatar_url = COALESCE(excluded.avatar_url, users.avatar_url)`,
    )
    .bind(
      id,
      email,
      now,
      input.githubId ?? null,
      input.githubLogin ?? null,
      input.displayName ?? null,
      input.avatarUrl ?? null,
      now,
    )
    .run();
  const row = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
  if (!row) throw new Error("user upsert did not persist");
  return row;
}

export async function insertSession(
  db: D1Database,
  s: { idHash: string; userId: string; userAgent: string; now: number },
): Promise<void> {
  const expires = s.now + 30 * 86400_000;
  await db
    .prepare(
      "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(s.idHash, s.userId, s.now, expires, s.userAgent.slice(0, 200))
    .run();
}

export async function findSession(
  db: D1Database,
  idHash: string,
  now: number,
): Promise<{ user_id: string; expires_at: number; created_at: number } | null> {
  const row = await db
    .prepare(
      "SELECT user_id, expires_at, created_at FROM sessions WHERE id_hash = ? AND expires_at > ?",
    )
    .bind(idHash, now)
    .first<{ user_id: string; expires_at: number; created_at: number }>();
  return row ?? null;
}

export async function touchSession(
  db: D1Database,
  idHash: string,
  expiresAt: number,
): Promise<void> {
  await db
    .prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?")
    .bind(expiresAt, idHash)
    .run();
}

export async function deleteSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
}

export async function insertMagicLink(
  db: D1Database,
  m: { tokenHash: string; email: string; now: number },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO magic_links (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(m.tokenHash, m.email.trim().toLowerCase(), m.now, m.now + MAGIC_LINK_TTL_MS)
    .run();
}

export async function consumeMagicLink(
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<string | null> {
  const res = await db
    .prepare(
      "UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email",
    )
    .bind(now, tokenHash, now)
    .first<{ email: string }>();
  return res?.email ?? null;
}

export async function insertApiKey(
  db: D1Database,
  k: { id: string; userId: string; keyHash: string; prefix: string; label: string; now: number },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO api_keys (id, user_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(k.id, k.userId, k.keyHash, k.prefix, k.label.slice(0, 60), k.now)
    .run();
}

export interface ApiKeyRow {
  readonly id: string;
  readonly prefix: string;
  readonly label: string;
  readonly created_at: number;
  readonly last_used_at: number | null;
  readonly revoked_at: number | null;
}

export async function listApiKeys(db: D1Database, userId: string): Promise<ApiKeyRow[]> {
  const r = await db
    .prepare(
      "SELECT id, prefix, label, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<ApiKeyRow>();
  return r.results;
}

export async function countActiveApiKeys(db: D1Database, userId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL")
    .bind(userId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function revokeApiKey(
  db: D1Database,
  userId: string,
  id: string,
  now: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(now, id, userId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function findApiKeyByHash(
  db: D1Database,
  keyHash: string,
): Promise<{ id: string; user_id: string; last_used_at: number | null } | null> {
  const r = await db
    .prepare(
      "SELECT id, user_id, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
    )
    .bind(keyHash)
    .first<{ id: string; user_id: string; last_used_at: number | null }>();
  return r ?? null;
}

export async function touchApiKey(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}
