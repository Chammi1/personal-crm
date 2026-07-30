-- Аватары, оценка отношений, питомцы, семейные связи.

ALTER TABLE person ADD COLUMN avatar TEXT;

-- Качество отношений 1..5. Отдельно от interest/difficulty/risk:
-- те про стратегию контакта, это — про то, насколько вам хорошо вместе.
ALTER TABLE person ADD COLUMN rapport INTEGER;

-- Карточка, созданная автоматически как родственник кого-то другого.
-- Не участвует в напоминаниях и не занимает место в круге, пока не активирована вручную.
ALTER TABLE person ADD COLUMN is_stub INTEGER NOT NULL DEFAULT 0;

CREATE TABLE pet (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  species    TEXT,
  breed      TEXT,
  avatar     TEXT,
  birthday   TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pet_owner ON pet(owner_id);

-- Событие может принадлежать питомцу: напоминание всё равно приходит про хозяина.
ALTER TABLE event ADD COLUMN pet_id INTEGER REFERENCES pet(id) ON DELETE CASCADE;

-- Производные связи (брат-сестра, родитель через супруга) пересчитываются автоматически.
ALTER TABLE relation ADD COLUMN derived INTEGER NOT NULL DEFAULT 0;
