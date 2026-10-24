-- An invite carries a short label for the owner's own reference, and can be
-- revoked before it is used. The room object drops a revoked invite outright;
-- D1 keeps the row so the owner's list still shows what was issued.
ALTER TABLE invites ADD COLUMN label TEXT;
ALTER TABLE invites ADD COLUMN revoked_at INTEGER;
