-- 专用 apple_account_research 库，显式迁移；禁止应用到业务库。
CREATE TABLE IF NOT EXISTS budget (
  id integer PRIMARY KEY,
  requests integer NOT NULL DEFAULT 0,
  last_request timestamptz
);
INSERT INTO budget(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS runs (
  id bigserial PRIMARY KEY,
  sample_id integer,
  mode text,
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  outcome text,
  requests integer DEFAULT 0
);
CREATE TABLE collector_attempts (
  run_id bigint PRIMARY KEY REFERENCES runs(id),
  order_hash text NOT NULL,
  account_hash text NOT NULL,
  proxy_hash text NOT NULL,
  login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collector_attempts_order_time ON collector_attempts(order_hash,created_at);
CREATE TABLE collector_pauses (
  scope text NOT NULL CHECK(scope IN ('account','proxy','login')),
  key text NOT NULL,
  reason text NOT NULL,
  until_at timestamptz NOT NULL,
  PRIMARY KEY(scope,key)
);
