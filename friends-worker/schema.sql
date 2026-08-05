-- AUTOcarl friends service. Crew-scale by design: tens of users, coarse data.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,             -- crypto.randomUUID()
  email      TEXT NOT NULL UNIQUE,         -- CARL email, lowercased
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL,                -- SHA-256 of the bearer secret
  created_at TEXT NOT NULL
);

-- One row per request; status flips to accepted on approval. (a requests b.)
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
);

-- Latest coarse schedule snapshot per user: job number/name, city/state, dates.
CREATE TABLE IF NOT EXISTS schedules (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gigs_json  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
