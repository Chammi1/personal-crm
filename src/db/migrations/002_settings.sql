-- Настройки и состояние разметки: цель по размеру базы, дневная норма, курсор по подсказкам.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('intake_target', '200'),
  ('intake_quota', '5'),
  ('prompt_cursor', '0');
