PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS funds (
  id TEXT PRIMARY KEY,
  initial_cash_cents INTEGER NOT NULL,
  cash_cents INTEGER NOT NULL,
  preset TEXT NOT NULL,
  chain TEXT NOT NULL,
  asset_universe TEXT NOT NULL DEFAULT 'top50',
  status TEXT NOT NULL,
  data_mode TEXT NOT NULL,
  current_cycle INTEGER NOT NULL DEFAULT 0,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_versions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  cycle INTEGER NOT NULL,
  mode TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  event_cutoff TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  coverage TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(fund_id, cycle)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  decision_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  cycle INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES observations(id),
  policy_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  before_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  orders_json TEXT NOT NULL,
  skipped_json TEXT NOT NULL,
  costs_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(fund_id, cycle, input_hash)
);

CREATE TABLE IF NOT EXISTS decision_evidence (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  evidence_type TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  fund_id TEXT NOT NULL REFERENCES funds(id),
  token TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  cost_basis_cents INTEGER NOT NULL DEFAULT 0,
  mark_cents INTEGER NOT NULL DEFAULT 0,
  target_weight REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(fund_id, token)
);

CREATE TABLE IF NOT EXISTS cash_entries (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  decision_id TEXT,
  entry_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  fund_id TEXT NOT NULL REFERENCES funds(id),
  token TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity_units INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  notional_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marks (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  token TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_calls (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  credits INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_observations_fund ON observations(fund_id, cycle DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_fund ON decisions(fund_id, cycle DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_fund ON jobs(fund_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marks_fund ON marks(fund_id, token, observed_at DESC);
