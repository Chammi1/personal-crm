import { db } from '../index.js';
import type { Circle, Dossier, Person } from '../types.js';

export interface NewPerson {
  name: string;
  circle?: Circle;
  telegram?: string | null;
  phone?: string | null;
  city?: string | null;
  met_on?: string | null;
  met_context?: string | null;
  met_via?: number | null;
  tags?: string[];
}

const insertPerson = db.prepare(`
  INSERT INTO person (name, circle, telegram, phone, city, met_on, met_context, met_via)
  VALUES (@name, @circle, @telegram, @phone, @city, @met_on, @met_context, @met_via)
`);
const insertDossier = db.prepare('INSERT INTO dossier (person_id) VALUES (?)');
const insertTag = db.prepare('INSERT OR IGNORE INTO tag (person_id, tag) VALUES (?, ?)');

export const create = db.transaction((p: NewPerson): number => {
  const info = insertPerson.run({
    name: p.name,
    circle: p.circle ?? 3,
    telegram: p.telegram ?? null,
    phone: p.phone ?? null,
    city: p.city ?? null,
    met_on: p.met_on ?? null,
    met_context: p.met_context ?? null,
    met_via: p.met_via ?? null,
  });
  const id = Number(info.lastInsertRowid);
  insertDossier.run(id);
  for (const t of p.tags ?? []) insertTag.run(id, t.toLowerCase());
  reindex(id);
  return id;
});

export function byId(id: number): Person | undefined {
  return db.prepare('SELECT * FROM person WHERE id = ?').get(id) as Person | undefined;
}

export function dossierOf(id: number): Dossier | undefined {
  return db.prepare('SELECT * FROM dossier WHERE person_id = ?').get(id) as Dossier | undefined;
}

export function tagsOf(id: number): string[] {
  return db.prepare('SELECT tag FROM tag WHERE person_id = ? ORDER BY tag').all(id)
    .map((r) => (r as { tag: string }).tag);
}

export function addTag(id: number, tag: string): void {
  insertTag.run(id, tag.toLowerCase());
  reindex(id);
}

export function setCircle(id: number, circle: Circle): void {
  db.prepare("UPDATE person SET circle = ?, updated_at = datetime('now') WHERE id = ?").run(circle, id);
}

export function setInterval(id: number, days: number | null): void {
  db.prepare("UPDATE person SET target_interval = ?, updated_at = datetime('now') WHERE id = ?").run(days, id);
}

export function setStatus(id: number, status: Person['status']): void {
  db.prepare("UPDATE person SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

const DOSSIER_FIELDS = ['family', 'occupation', 'recreation', 'dreams', 'hooks', 'avoid', 'gift_ideas'] as const;
export type DossierField = (typeof DOSSIER_FIELDS)[number];

export function isDossierField(s: string): s is DossierField {
  return (DOSSIER_FIELDS as readonly string[]).includes(s);
}

/** Дописывает в блок досье, а не затирает: факты накапливаются. */
export function appendDossier(id: number, field: DossierField, text: string): void {
  const row = dossierOf(id);
  const prev = row?.[field] ?? null;
  const next = prev ? `${prev}\n${text}` : text;
  db.prepare(`UPDATE dossier SET ${field} = ?, updated_at = datetime('now') WHERE person_id = ?`).run(next, id);
  reindex(id);
}

export function active(): Person[] {
  return db.prepare("SELECT * FROM person WHERE status = 'active' ORDER BY circle, name").all() as Person[];
}

export function countsByCircle(): Record<number, number> {
  const rows = db.prepare(
    "SELECT circle, COUNT(*) AS n FROM person WHERE status = 'active' GROUP BY circle",
  ).all() as { circle: number; n: number }[];
  const out: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of rows) out[r.circle] = r.n;
  return out;
}

/** Все теги с частотой — для подсказок в форме добавления. */
export function allTags(): { tag: string; n: number }[] {
  return db.prepare(
    'SELECT tag, COUNT(*) AS n FROM tag GROUP BY tag ORDER BY n DESC, tag',
  ).all() as { tag: string; n: number }[];
}

/** Люди, по которым нет ни одного зафиксированного контакта. */
export function withoutContact(limit = 20): Person[] {
  return db.prepare(`
    SELECT p.* FROM person p
    WHERE p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM interaction i WHERE i.person_id = p.id)
    ORDER BY p.circle, p.name
    LIMIT ?
  `).all(limit) as Person[];
}

/** Полнотекстовый поиск по имени, городу, тегам, досье и заметкам. */
export function search(query: string, limit = 10): Person[] {
  const q = query.trim().replace(/["']/g, '');
  if (!q) return [];
  try {
    return db.prepare(`
      SELECT p.* FROM search_index s
      JOIN person p ON p.id = s.person_id
      WHERE search_index MATCH ?
      ORDER BY rank LIMIT ?
    `).all(`${q}*`, limit) as Person[];
  } catch {
    return db.prepare('SELECT * FROM person WHERE name LIKE ? LIMIT ?').all(`%${q}%`, limit) as Person[];
  }
}

/** Пересборка поискового документа. Дёргается после любой записи по человеку. */
export function reindex(id: number): void {
  const p = byId(id);
  if (!p) return;
  const d = dossierOf(id);
  const tags = tagsOf(id).join(' ');
  const notes = db.prepare('SELECT body FROM note WHERE person_id = ? ORDER BY id DESC LIMIT 40')
    .all(id).map((r) => (r as { body: string }).body).join(' ');

  const body = [
    p.name, p.aliases, p.city, p.telegram, p.met_context, tags,
    d?.family, d?.occupation, d?.recreation, d?.dreams, d?.hooks, d?.gift_ideas,
    notes,
  ].filter(Boolean).join(' \n ');

  db.prepare('DELETE FROM search_index WHERE person_id = ?').run(id);
  db.prepare('INSERT INTO search_index (body, person_id) VALUES (?, ?)').run(body, id);
}

export function reindexAll(): void {
  for (const p of active()) reindex(p.id);
}
