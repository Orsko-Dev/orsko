-- Feedback left through /feedback. A note is kept as the visitor typed it,
-- with the page they were on (room ids already collapsed to /r/:room) and the
-- account when they were signed in. The reply address is optional: a note with
-- no contact is anonymous and stays that way.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  contact TEXT,
  page TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX feedback_created_at ON feedback (created_at DESC);
