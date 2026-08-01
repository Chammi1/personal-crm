import { db } from '../index.js';
import { leadDaysDefault } from './agenda.js';

/**
 * Коллективные события: один повод на весь кластер.
 * Забег для #бег, Новый год для всех, встреча курса для #универ.
 * Сигнал получает каждый активный человек с тегом события
 * (или вся сеть, если тег не задан).
 */

export interface CollectiveEvent {
  id: number;
  title: string;
  event_date: string;
  tag: string | null;
  recurring: number;
  lead_days: number;
  note: string | null;
  handled_for: string | null;
}

export function add(
  title: string,
  eventDate: string,
  opts: { tag?: string | null; recurring?: boolean; leadDays?: number; note?: string | null } = {},
): number {
  const info = db.prepare(`
    INSERT INTO collective_event (title, event_date, tag, recurring, lead_days, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    title, eventDate, opts.tag ?? null,
    opts.recurring ? 1 : 0,
    opts.leadDays ?? leadDaysDefault(),
    opts.note ?? null,
  );
  return Number(info.lastInsertRowid);
}

export function all(): CollectiveEvent[] {
  return db.prepare('SELECT * FROM collective_event ORDER BY event_date').all() as CollectiveEvent[];
}

export function remove(id: number): void {
  db.prepare('DELETE FROM collective_event WHERE id = ?').run(id);
}

/** Закрывает конкретное наступление: «все поздравлены» — до следующего года тишина. */
export function markHandled(id: number, occurrence: string): void {
  db.prepare('UPDATE collective_event SET handled_for = ? WHERE id = ?').run(occurrence, id);
}
