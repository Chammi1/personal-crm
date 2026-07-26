import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Раннер миграций: применяет .sql-файлы по возрастанию имени, ровно один раз.
 * Идемпотентен.
 */
export function migrate(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migration (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM _migration').all().map((r) => (r as { name: string }).name),
  );

  const dir = join(here, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const record = db.prepare('INSERT INTO _migration (name) VALUES (?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file);
    })();
    console.log(`[db] применена миграция ${file}`);
  }
}

/**
 * Миграции запускаются здесь, а не в main().
 * Причина: репозитории готовят prepared statements на верхнем уровне модуля,
 * а ESM выполняет импорты до тела вызывающего файла — к моменту prepare
 * таблицы уже должны существовать.
 */
migrate();
