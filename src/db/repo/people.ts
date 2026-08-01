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

/** Частичное обновление. Разрешённые поля перечислены явно, чтобы из API нельзя было тронуть лишнее. */
const UPDATABLE = [
  'name', 'telegram', 'phone', 'email', 'city',
  'met_on', 'met_context', 'met_via', 'target_interval',
  'is_connector', 'is_condenser', 'interest', 'difficulty', 'risk', 'rapport',
] as const;
export type UpdatableField = (typeof UPDATABLE)[number];

export function update(id: number, patch: Partial<Record<UpdatableField, unknown>>): void {
  const fields = Object.keys(patch).filter((k): k is UpdatableField =>
    (UPDATABLE as readonly string[]).includes(k));
  if (!fields.length) return;

  const sql = `UPDATE person SET ${fields.map((f) => `${f} = @${f}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`;
  const params: Record<string, unknown> = { id };
  for (const f of fields) {
    const v = patch[f];
    params[f] = v === '' || v === undefined ? null : v;
  }
  db.prepare(sql).run(params);
  reindex(id);
}

/** Полная замена блоков досье — в отличие от appendDossier, который дописывает. */
export function setDossier(id: number, values: Partial<Record<DossierField, string | null>>): void {
  const fields = Object.keys(values).filter(isDossierField);
  if (!fields.length) return;
  const sql = `UPDATE dossier SET ${fields.map((f) => `${f} = @${f}`).join(', ')}, updated_at = datetime('now') WHERE person_id = @id`;
  const params: Record<string, unknown> = { id };
  for (const f of fields) params[f] = values[f]?.trim() || null;
  db.prepare(sql).run(params);
  reindex(id);
}

/** Полная замена набора тегов. */
export const setTags = db.transaction((id: number, tags: string[]): void => {
  db.prepare('DELETE FROM tag WHERE person_id = ?').run(id);
  for (const t of tags) {
    const clean = t.trim().toLowerCase();
    if (clean) insertTag.run(id, clean);
  }
  reindex(id);
});

/**
 * Полное удаление вместе со всей историей. Необратимо.
 * Для «убрать с глаз» есть архив: setStatus(id, 'archived').
 */
export function remove(id: number): void {
  db.prepare('DELETE FROM search_index WHERE person_id = ?').run(id);
  db.prepare('DELETE FROM person WHERE id = ?').run(id);
}

export function setAvatar(id: number, file: string): void {
  db.prepare("UPDATE person SET avatar = ?, updated_at = datetime('now') WHERE id = ?").run(file, id);
}

export function archived(): Person[] {
  return db.prepare("SELECT * FROM person WHERE status = 'archived' ORDER BY name").all() as Person[];
}

/**
 * Активные люди без карточек-заглушек.
 * Заглушки — автосозданные родственники: они видны в блоке семьи,
 * но не занимают место в круге и не порождают напоминаний.
 */
export function active(): Person[] {
  return db.prepare(
    "SELECT * FROM person WHERE status = 'active' AND is_stub = 0 ORDER BY circle, name",
  ).all() as Person[];
}

export function countsByCircle(): Record<number, number> {
  const rows = db.prepare(
    "SELECT circle, COUNT(*) AS n FROM person WHERE status = 'active' AND is_stub = 0 GROUP BY circle",
  ).all() as { circle: number; n: number }[];
  const out: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of rows) out[r.circle] = r.n;
  return out;
}

/** Кого этот человек привёл в сеть (у кого он met_via). */
export function introduced(id: number): Person[] {
  return db.prepare(
    "SELECT * FROM person WHERE met_via = ? AND status = 'active' ORDER BY name",
  ).all(id) as Person[];
}

/** Топ коннекторов: кто скольких привёл. */
export function connectorTop(limit = 5): { person: Person; n: number }[] {
  const rows = db.prepare(`
    SELECT via.*, COUNT(p.id) AS n FROM person p
    JOIN person via ON via.id = p.met_via
    WHERE p.status = 'active' AND via.status = 'active'
    GROUP BY p.met_via ORDER BY n DESC LIMIT ?
  `).all(limit) as (Person & { n: number })[];
  return rows.map((r) => {
    const { n, ...person } = r;
    return { person: person as Person, n };
  });
}

/** Теги всех активных одним запросом — вместо N+1 при сборке карты и справочника. */
export function tagsOfAll(): Map<number, string[]> {
  const rows = db.prepare(`
    SELECT t.person_id, t.tag FROM tag t
    JOIN person p ON p.id = t.person_id
    WHERE p.status = 'active'
    ORDER BY t.tag
  `).all() as { person_id: number; tag: string }[];
  const out = new Map<number, string[]>();
  for (const r of rows) {
    const list = out.get(r.person_id);
    if (list) list.push(r.tag);
    else out.set(r.person_id, [r.tag]);
  }
  return out;
}

/** Род деятельности всех одним запросом — для справочника. */
export function occupationsOfAll(): Map<number, string> {
  const rows = db.prepare(
    "SELECT person_id, occupation FROM dossier WHERE occupation IS NOT NULL AND occupation != ''",
  ).all() as { person_id: number; occupation: string }[];
  return new Map(rows.map((r) => [r.person_id, r.occupation]));
}

/** Активные люди с тегом — аудитория коллективного события. */
export function withTag(tag: string): Person[] {
  return db.prepare(`
    SELECT p.* FROM person p
    JOIN tag t ON t.person_id = p.id
    WHERE t.tag = ? AND p.status = 'active' AND p.is_stub = 0
    ORDER BY p.circle, p.name
  `).all(tag.toLowerCase()) as Person[];
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
      AND p.is_stub = 0
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
