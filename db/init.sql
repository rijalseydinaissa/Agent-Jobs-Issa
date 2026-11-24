-- Base applicative séparée de la base interne de n8n
CREATE DATABASE jobs;
\c jobs

CREATE TABLE offers (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  -- entreprise + titre normalisés : évite les doublons entre sources
  dedupe_key    TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  company       TEXT,
  location      TEXT,
  salary        TEXT,
  tags          TEXT,
  url           TEXT,
  apply_url     TEXT,
  contact_email TEXT,
  description   TEXT,
  published_at  TIMESTAMPTZ,

  score         INT,
  analysis      JSONB,
  email_subject TEXT,
  cover_letter  TEXT,

  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
                  'new',               -- collectée, pas encore analysée
                  'filtered',          -- score trop bas
                  'pending_review',    -- en attente de VOTRE validation
                  'approved',          -- validée, envoi en cours
                  'rejected',          -- rejetée par vous
                  'applied',           -- candidature envoyée par email
                  'to_apply_manually', -- validée, formulaire à remplir vous-même
                  'send_failed'        -- l'email n'est pas parti
                )),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  applied_at    TIMESTAMPTZ
);

CREATE INDEX offers_status_idx ON offers (status, published_at DESC);

-- Petit état persistant (offset du polling Telegram)
CREATE TABLE bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO bot_state (key, value) VALUES ('telegram_offset', '0');

-- Vue pratique pour un dashboard
CREATE VIEW stats AS
SELECT
  count(*)                                              AS offres_collectees,
  count(*) FILTER (WHERE score IS NOT NULL)             AS offres_analysees,
  count(*) FILTER (WHERE status = 'pending_review')     AS en_attente,
  count(*) FILTER (WHERE status = 'rejected')           AS rejetees,
  count(*) FILTER (WHERE status = 'applied')            AS envoyees,
  count(*) FILTER (WHERE status = 'to_apply_manually')  AS a_postuler_manuellement,
  round(avg(score) FILTER (WHERE score IS NOT NULL), 1) AS score_moyen
FROM offers;
