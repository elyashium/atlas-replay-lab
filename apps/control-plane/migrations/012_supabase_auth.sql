CREATE TABLE auth_identities (
  provider text NOT NULL CHECK (provider = 'supabase'),
  subject text NOT NULL CHECK (subject ~ '^[0-9a-fA-F-]{36}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, user_id)
);
