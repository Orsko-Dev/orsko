CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified_at INTEGER,
  github_id TEXT UNIQUE,
  github_login TEXT,
  display_name TEXT,
  avatar_url TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_keys_user ON api_keys(user_id);
CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY,
  creator_user_id TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  purpose TEXT,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  last_activity_at INTEGER NOT NULL,
  archived_at INTEGER,
  expired_at INTEGER,
  reconciled_at INTEGER
);
CREATE INDEX rooms_creator ON rooms(creator_user_id);
CREATE TABLE room_members (
  room_id TEXT NOT NULL,
  member_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  user_id TEXT,
  invite_id TEXT,
  joined_at INTEGER NOT NULL,
  left_at INTEGER
);
CREATE INDEX room_members_user ON room_members(user_id);
CREATE INDEX room_members_room ON room_members(room_id);
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  issued_by_user_id TEXT NOT NULL,
  addressed_email TEXT,
  addressed_github_login TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_member_id TEXT
);
CREATE INDEX invites_room ON invites(room_id);
CREATE INDEX invites_addressed_email ON invites(addressed_email);
CREATE INDEX invites_addressed_login ON invites(addressed_github_login);
