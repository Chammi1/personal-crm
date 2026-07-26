import { db } from '../index.js';
import { today } from '../../domain/dates.js';
import type { Channel, Interaction, Note } from '../types.js';
import { reindex } from './people.js';

export function logInteraction(
  personId: number,
  channel: Channel,
  opts: { on?: string; initiator?: 'me' | 'them'; summary?: string } = {},
): number {
  const info = db.prepare(`
    INSERT INTO interaction (person_id, happened_on, channel, initiator, summary)
    VALUES (?, ?, ?, ?, ?)
  `).run(personId, opts.on ?? today(), channel, opts.initiator ?? 'me', opts.summary ?? null);
  db.prepare('DELETE FROM snooze WHERE person_id = ?').run(personId);
  return Number(info.lastInsertRowid);
}

export function lastInteraction(personId: number): Interaction | undefined {
  return db.prepare(
    'SELECT * FROM interaction WHERE person_id = ? ORDER BY happened_on DESC, id DESC LIMIT 1',
  ).get(personId) as Interaction | undefined;
}

/** Даты последнего контакта разом по всей сети — чтобы не дёргать базу в цикле. */
export function lastContactMap(): Map<number, string> {
  const rows = db.prepare(
    'SELECT person_id, MAX(happened_on) AS last_on FROM interaction GROUP BY person_id',
  ).all() as { person_id: number; last_on: string }[];
  return new Map(rows.map((r) => [r.person_id, r.last_on]));
}

export function addNote(personId: number, body: string, source: Note['source'] = 'manual'): number {
  const info = db.prepare(
    'INSERT INTO note (person_id, written_on, body, source) VALUES (?, ?, ?, ?)',
  ).run(personId, today(), body, source);
  reindex(personId);
  return Number(info.lastInsertRowid);
}

export function notesOf(personId: number, limit = 5): Note[] {
  return db.prepare(
    'SELECT * FROM note WHERE person_id = ? ORDER BY written_on DESC, id DESC LIMIT ?',
  ).all(personId, limit) as Note[];
}

export function snooze(personId: number, untilOn: string): void {
  db.prepare('INSERT OR REPLACE INTO snooze (person_id, until_on) VALUES (?, ?)').run(personId, untilOn);
}

export function snoozedUntil(): Map<number, string> {
  const rows = db.prepare('SELECT person_id, until_on FROM snooze').all() as
    { person_id: number; until_on: string }[];
  return new Map(rows.map((r) => [r.person_id, r.until_on]));
}
