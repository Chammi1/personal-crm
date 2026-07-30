import { db } from '../db/index.js';
import type { Person } from '../db/types.js';
import * as people from '../db/repo/people.js';

/**
 * Семейные связи.
 *
 * Явные связи (супруг, родитель, ребёнок) заводит человек, производные
 * (брат-сестра, родитель через супруга) вычисляются и помечаются derived=1.
 * Пересчёт полный по семейному кластеру: так связи не разъезжаются
 * после правок и удалений.
 */

export type FamilyRole = 'spouse' | 'parent' | 'child' | 'sibling' | 'relative';

export const ROLE_LABEL: Record<FamilyRole, string> = {
  spouse: 'супруг(а)', parent: 'родитель', child: 'ребёнок',
  sibling: 'брат/сестра', relative: 'родственник',
};

const insertRel = db.prepare(
  'INSERT OR IGNORE INTO relation (from_id, to_id, kind, label, derived) VALUES (?, ?, ?, ?, ?)',
);

/** Обратная роль: если А родитель Б, то Б ребёнок А. */
const INVERSE: Record<FamilyRole, FamilyRole> = {
  spouse: 'spouse', parent: 'child', child: 'parent',
  sibling: 'sibling', relative: 'relative',
};

/**
 * Семантика записи: (from_id, to_id, kind) читается как
 * «to_id является kind по отношению к from_id».
 * link(Аня, Мира, 'child') — Мира ребёнок Ани.
 */
export function link(fromId: number, toId: number, role: FamilyRole, derived = false): void {
  if (fromId === toId) return;
  insertRel.run(fromId, toId, role, ROLE_LABEL[role], derived ? 1 : 0);
  insertRel.run(toId, fromId, INVERSE[role], ROLE_LABEL[INVERSE[role]], derived ? 1 : 0);
}

export function unlink(aId: number, bId: number): void {
  db.prepare('DELETE FROM relation WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)')
    .run(aId, bId, bId, aId);
}

function direct(id: number, kind: FamilyRole): number[] {
  return db.prepare('SELECT to_id FROM relation WHERE from_id = ? AND kind = ?')
    .all(id, kind).map((r) => (r as { to_id: number }).to_id);
}

/** Все, кто связан родством с этим человеком — обход в ширину по семейным связям. */
export function household(rootId: number): number[] {
  const seen = new Set<number>([rootId]);
  const queue = [rootId];
  const kinds = "('spouse','parent','child','sibling','relative')";
  while (queue.length) {
    const id = queue.shift()!;
    const next = db.prepare(`SELECT to_id FROM relation WHERE from_id = ? AND kind IN ${kinds}`)
      .all(id).map((r) => (r as { to_id: number }).to_id);
    for (const n of next) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return [...seen];
}

/**
 * Пересчёт производных связей внутри семьи.
 * Правила: дети одного родителя — братья и сёстры; супруг родителя — тоже родитель.
 */
export function rebuildDerived(rootId: number): void {
  const members = household(rootId);
  if (members.length < 2) return;

  db.prepare(`DELETE FROM relation WHERE derived = 1 AND from_id IN (${members.map(() => '?').join(',')})`)
    .run(...members);

  for (const id of members) {
    const kids = direct(id, 'child');

    // дети одного родителя — сиблинги
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) link(kids[i]!, kids[j]!, 'sibling', true);
    }

    // супруг родителя тоже считается родителем этих детей
    for (const spouse of direct(id, 'spouse')) {
      for (const kid of kids) link(spouse, kid, 'child', true);
    }
  }
}

export interface FamilyMemberInput {
  name: string;
  role: FamilyRole;
  birthday?: string | null;
  note?: string | null;
}

/**
 * Добавляет родственника: создаёт карточку-заглушку, связывает и пересчитывает семью.
 * Заглушка не участвует в напоминаниях, пока её не активируют вручную.
 */
export function addMember(personId: number, input: FamilyMemberInput): number {
  const id = people.create({ name: input.name.trim(), circle: 4 });
  db.prepare('UPDATE person SET is_stub = 1 WHERE id = ?').run(id);
  link(personId, id, input.role);
  rebuildDerived(personId);
  return id;
}

export interface FamilyView {
  id: number;
  name: string;
  role: FamilyRole;
  label: string;
  derived: boolean;
  isStub: boolean;
  avatar: string | null;
}

export function familyOf(personId: number): FamilyView[] {
  const rows = db.prepare(`
    SELECT r.to_id AS id, r.kind AS role, r.derived, p.name, p.is_stub, p.avatar
    FROM relation r JOIN person p ON p.id = r.to_id
    WHERE r.from_id = ? AND r.kind IN ('spouse','parent','child','sibling','relative')
    ORDER BY CASE r.kind
      WHEN 'spouse' THEN 0 WHEN 'child' THEN 1 WHEN 'parent' THEN 2
      WHEN 'sibling' THEN 3 ELSE 4 END, p.name
  `).all(personId) as {
    id: number; role: FamilyRole; derived: number; name: string; is_stub: number; avatar: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id, name: r.name, role: r.role, label: ROLE_LABEL[r.role],
    derived: r.derived === 1, isStub: r.is_stub === 1, avatar: r.avatar,
  }));
}

export interface StubOwner {
  person: Person;
  /** Роль заглушки по отношению к владельцу: «ребёнок», «супруг(а)»… */
  label: string;
}

/**
 * Активные владельцы карточки-заглушки — люди, к чьей семье она относится.
 * Через них события заглушки (день рождения ребёнка) попадают в сигналы:
 * сама заглушка в напоминаниях не участвует, но повод написать — владельцу.
 */
export function ownersOf(stubId: number): StubOwner[] {
  const rows = db.prepare(`
    SELECT p.*, r.kind AS stub_role FROM relation r
    JOIN person p ON p.id = r.from_id
    WHERE r.to_id = ?
      AND r.kind IN ('spouse','parent','child','sibling','relative')
      AND p.status = 'active' AND p.is_stub = 0
  `).all(stubId) as (Person & { stub_role: FamilyRole })[];

  return rows.map((r) => {
    const { stub_role, ...person } = r;
    return { person: person as Person, label: ROLE_LABEL[stub_role] };
  });
}

/** Перевод заглушки в полноценную карточку. */
export function activate(id: number, circle = 3): void {
  db.prepare('UPDATE person SET is_stub = 0, circle = ? WHERE id = ?').run(circle, id);
}

export function stubs(): Person[] {
  return db.prepare("SELECT * FROM person WHERE is_stub = 1 AND status = 'active' ORDER BY name")
    .all() as Person[];
}
