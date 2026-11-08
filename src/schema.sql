CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  name text NOT NULL,
  accent text NOT NULL CHECK (accent ~ '^#[0-9a-fA-F]{6}$')
);

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  platform_admin boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS memberships (
  tenant_id uuid REFERENCES tenants(id),
  account_id uuid REFERENCES accounts(id),
  role text NOT NULL CHECK (role IN ('tenant_admin', 'coordinator')),
  PRIMARY KEY (tenant_id, account_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  tenant_id uuid REFERENCES tenants(id),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_details', 'ready_for_planning')),
  details jsonb NOT NULL,
  missing_fields text[] NOT NULL,
  proposed_follow_up text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES memberships(tenant_id, account_id)
);

CREATE INDEX IF NOT EXISTS requests_tenant_queue ON requests (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intake_messages (
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  source text NOT NULL,
  provider_event_id text NOT NULL,
  sender text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source, provider_event_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id)
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/New_York';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'English';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('tenant_admin', 'coordinator', 'reviewer'));
ALTER TABLE requests ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS workflow jsonb NOT NULL DEFAULT '{}';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check CHECK (status IN ('awaiting_details', 'ready_for_planning', 'confirmed'));
ALTER TABLE intake_messages ADD COLUMN IF NOT EXISTS thread_id text;
ALTER TABLE intake_messages ADD COLUMN IF NOT EXISTS internet_id text;
ALTER TABLE intake_messages ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'inbound';
CREATE INDEX IF NOT EXISTS intake_thread ON intake_messages (tenant_id, source, thread_id);

CREATE TABLE IF NOT EXISTS timeline (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS school_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  contact text NOT NULL,
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('collaborator', 'approver', 'logistics')),
  digest text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  revoked boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, request_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_designated_approver
  ON school_links (tenant_id, request_id) WHERE purpose = 'approver' AND NOT revoked;

CREATE TABLE IF NOT EXISTS deck_versions (
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  version integer NOT NULL,
  object_key text NOT NULL,
  checksum text NOT NULL,
  content jsonb NOT NULL,
  author_id uuid NOT NULL REFERENCES accounts(id),
  cleared_by uuid REFERENCES accounts(id),
  cleared_at timestamptz,
  shared_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  PRIMARY KEY (tenant_id, request_id, version),
  FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id),
  FOREIGN KEY (tenant_id, request_id, approved_by) REFERENCES school_links(tenant_id, request_id, id)
);

CREATE TABLE IF NOT EXISTS deck_comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  version integer NOT NULL,
  contact_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, request_id, version) REFERENCES deck_versions(tenant_id, request_id, version),
  FOREIGN KEY (tenant_id, request_id, contact_id) REFERENCES school_links(tenant_id, request_id, id)
);

CREATE TABLE IF NOT EXISTS venue_rooms (
  tenant_id uuid REFERENCES tenants(id),
  id text,
  venue text NOT NULL,
  room text NOT NULL,
  zip text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  capacity integer NOT NULL,
  opens time NOT NULL,
  closes time NOT NULL,
  amenities text[] NOT NULL,
  demo_hold boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS room_reservations (
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  room_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id),
  FOREIGN KEY (tenant_id, room_id) REFERENCES venue_rooms(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS room_reservations_overlap ON room_reservations (tenant_id, room_id, starts_at);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('planning', 'follow_up', 'confirmation', 'reminder', 'cutoff')),
  operation text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed', 'cancelled')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  UNIQUE (tenant_id, request_id, operation),
  FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (run_at) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS provider_connections (
  tenant_id uuid REFERENCES tenants(id),
  kind text CHECK (kind IN ('mail', 'calendar')),
  provider text NOT NULL DEFAULT 'google',
  resource text NOT NULL,
  credential text NOT NULL,
  PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE IF NOT EXISTS oauth_flows (
  digest text PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  account_id uuid REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('mail', 'calendar', 'login')),
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS google_identities (
  subject text PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id)
);

ALTER TABLE school_links ADD COLUMN IF NOT EXISTS workshop_revision integer;
ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS last_sync timestamptz;
ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS demo_account boolean NOT NULL DEFAULT false;
