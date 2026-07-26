-- Связь с внешними системами (пока одна — СОТА CRM).
-- Ключ (source, external_id) делает синхронизацию идемпотентной:
-- повторный прогон находит того же человека, а не плодит дубли.
CREATE TABLE external_link (
  source      TEXT NOT NULL,                 -- 'sota'
  external_id TEXT NOT NULL,                 -- id записи во внешней базе
  person_id   INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  synced_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, external_id)
);
CREATE INDEX idx_external_person ON external_link(person_id);

-- Адрес приезжает из СОТА (куда слали медальницу) и здесь полезен для подарков и открыток.
ALTER TABLE person ADD COLUMN address TEXT;
