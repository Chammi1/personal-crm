-- Базовая схема личной CRM.
-- Принцип: факт общения хранится строками в interaction, а не полем last_contact,
-- иначе теряется история и невозможна аналитика.

CREATE TABLE person (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  aliases         TEXT,
  telegram        TEXT,
  phone           TEXT,
  email           TEXT,
  city            TEXT,

  circle          INTEGER NOT NULL DEFAULT 3,      -- 0..4, слои Данбара
  target_interval INTEGER,                         -- дней; NULL = взять из круга

  met_on          TEXT,                            -- ISO дата знакомства
  met_context     TEXT,                            -- где и при каких обстоятельствах
  met_via         INTEGER REFERENCES person(id) ON DELETE SET NULL,

  is_connector    INTEGER NOT NULL DEFAULT 0,      -- мост между группами
  is_condenser    INTEGER NOT NULL DEFAULT 0,      -- центр притяжения группы

  interest        INTEGER,                         -- 1..5
  difficulty      INTEGER,                         -- 1..5
  risk            INTEGER,                         -- 1..5

  status          TEXT NOT NULL DEFAULT 'active',  -- active | paused | archived
  layout_angle    REAL,                            -- закреплённый угол на карте

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_person_status ON person(status, circle);
CREATE INDEX idx_person_city   ON person(city);

-- Досье по схеме FORD + служебные блоки
CREATE TABLE dossier (
  person_id   INTEGER PRIMARY KEY REFERENCES person(id) ON DELETE CASCADE,
  family      TEXT,
  occupation  TEXT,
  recreation  TEXT,
  dreams      TEXT,
  hooks       TEXT,       -- общий контекст, внутренние шутки
  avoid       TEXT,       -- о чём не стоит
  gift_ideas  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE interaction (
  id          INTEGER PRIMARY KEY,
  person_id   INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  happened_on TEXT NOT NULL,                       -- YYYY-MM-DD
  channel     TEXT NOT NULL,                       -- message | call | meeting | event
  initiator   TEXT NOT NULL DEFAULT 'me',          -- me | them
  summary     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_interaction_person ON interaction(person_id, happened_on DESC);

CREATE TABLE note (
  id         INTEGER PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  written_on TEXT NOT NULL,
  body       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'manual',       -- manual | voice | import
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_note_person ON note(person_id, written_on DESC);

CREATE TABLE event (
  id           INTEGER PRIMARY KEY,
  person_id    INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                      -- birthday | anniversary | custom
  title        TEXT,
  event_date   TEXT NOT NULL,                      -- YYYY-MM-DD; для годовых год = год первого события
  recurring    INTEGER NOT NULL DEFAULT 0,         -- 1 = каждый год
  lead_days    INTEGER NOT NULL DEFAULT 30,        -- за сколько дней проявляется на карте
  handled_for  TEXT,                               -- YYYY-MM-DD последнего закрытого повода
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_event_person ON event(person_id);

CREATE TABLE task (
  id         INTEGER PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL,                        -- i_owe | they_owe
  body       TEXT NOT NULL,
  due_on     TEXT,
  done_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_open ON task(done_at, due_on);

CREATE TABLE relation (
  id        INTEGER PRIMARY KEY,
  from_id   INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  to_id     INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,                         -- family | romantic | colleague | met_at | friend | introduced_by | mentor
  label     TEXT,
  strength  INTEGER NOT NULL DEFAULT 1,
  UNIQUE(from_id, to_id, kind)
);
CREATE INDEX idx_relation_from ON relation(from_id);
CREATE INDEX idx_relation_to   ON relation(to_id);

CREATE TABLE tag (
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (person_id, tag)
);
CREATE INDEX idx_tag_name ON tag(tag);

-- Коллективные события: забег, Новый год, встреча курса.
CREATE TABLE collective_event (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  event_date TEXT NOT NULL,
  tag        TEXT,                                 -- какой кластер затрагивает
  recurring  INTEGER NOT NULL DEFAULT 0,
  lead_days  INTEGER NOT NULL DEFAULT 21,
  note       TEXT
);

-- Отложенные сигналы: «не показывай этого человека до даты».
CREATE TABLE snooze (
  person_id INTEGER PRIMARY KEY REFERENCES person(id) ON DELETE CASCADE,
  until_on  TEXT NOT NULL
);

-- Полнотекстовый поиск: собранный документ по человеку.
CREATE VIRTUAL TABLE search_index USING fts5(
  body,
  person_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
