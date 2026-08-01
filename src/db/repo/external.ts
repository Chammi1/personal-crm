import { db } from '../index.js';
import type { Person } from '../types.js';

/** Связка «человек здесь» ↔ «запись во внешней системе». */

export function personIdFor(source: string, externalId: string): number | undefined {
  const row = db.prepare(
    'SELECT person_id FROM external_link WHERE source = ? AND external_id = ?',
  ).get(source, externalId) as { person_id: number } | undefined;
  return row?.person_id;
}

export function link(source: string, externalId: string, personId: number): void {
  db.prepare(`
    INSERT INTO external_link (source, external_id, person_id, synced_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (source, external_id)
    DO UPDATE SET person_id = excluded.person_id, synced_at = datetime('now')
  `).run(source, externalId, personId);
}

export function linksOf(personId: number): { source: string; external_id: string }[] {
  return db.prepare(
    'SELECT source, external_id FROM external_link WHERE person_id = ?',
  ).all(personId) as { source: string; external_id: string }[];
}

export function countBySource(source: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM external_link WHERE source = ?')
    .get(source) as { n: number };
  return row.n;
}

const digits = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '');

/**
 * Поиск уже существующего человека по контактам — чтобы клиент СОТА,
 * который давно записан в «Круге» руками, не превратился во второго Ивана Иванова.
 * Порядок важен: telegram надёжнее телефона, телефон надёжнее почты.
 */
export function matchByContacts(
  c: { telegram?: string | null; phone?: string | null; email?: string | null },
): Person | undefined {
  // Только живые полноценные карточки: матч на архивную или заглушку
  // привязал бы внешнего клиента к невидимой записи.
  const LIVE = "status = 'active' AND is_stub = 0";

  const tg = (c.telegram ?? '').replace(/^@/, '').trim().toLowerCase();
  if (tg) {
    const hit = db.prepare(`SELECT * FROM person WHERE lower(telegram) = ? AND ${LIVE} LIMIT 1`)
      .get(tg) as Person | undefined;
    if (hit) return hit;
  }

  const phone = digits(c.phone);
  if (phone.length >= 10) {
    // Телефоны в базе записаны как попало («+7 900…», «8900…»), поэтому
    // сравниваем последние 10 цифр уже в JS. База личная, счёт на сотни строк.
    const tail = phone.slice(-10);
    const rows = db.prepare(`SELECT * FROM person WHERE phone IS NOT NULL AND phone != '' AND ${LIVE}`)
      .all() as Person[];
    const hit = rows.find((p) => digits(p.phone).slice(-10) === tail);
    if (hit) return hit;
  }

  const email = (c.email ?? '').trim().toLowerCase();
  if (email) {
    const hit = db.prepare(`SELECT * FROM person WHERE lower(email) = ? AND ${LIVE} LIMIT 1`)
      .get(email) as Person | undefined;
    if (hit) return hit;
  }

  return undefined;
}
