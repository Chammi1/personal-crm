import { db } from '../index.js';

const read = db.prepare('SELECT value FROM settings WHERE key = ?');
const write = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

export function get(key: string, fallback: string): string {
  const row = read.get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function getNumber(key: string, fallback: number): number {
  const n = Number(get(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

export function set(key: string, value: string | number): void {
  write.run(key, String(value));
}
