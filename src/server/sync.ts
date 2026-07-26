import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { config } from '../config.js';
import { db } from '../db/index.js';
import * as people from '../db/repo/people.js';
import * as timeline from '../db/repo/timeline.js';
import * as agenda from '../db/repo/agenda.js';
import * as external from '../db/repo/external.js';
import { isCircle } from '../domain/circles.js';
import { parseBirthday } from '../domain/parse.js';
import type { Channel, Circle, Person } from '../db/types.js';

/**
 * Приём данных из внешних систем (СОТА CRM).
 *
 * Отдельная ветка от /api: там доступ по подписи Telegram, а сюда стучится
 * сервер, у которого никакого initData нет. Защита — общий секрет SYNC_TOKEN.
 *
 * Главный принцип: синхронизация ДОПОЛНЯЕТ, но не затирает. Всё, что уже
 * заполнено руками в «Круге», остаётся как есть — внешняя система вписывает
 * только пустые поля. Иначе один прогон синхрона стёр бы живые правки.
 */
export const sync = new Hono();

sync.use('/*', async (c, next) => {
  if (!config.syncToken) {
    return c.json({ error: 'синхронизация выключена: в .env не задан SYNC_TOKEN' }, 503);
  }
  const given = Buffer.from(c.req.header('X-Sync-Token') ?? '');
  const want = Buffer.from(config.syncToken);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return next();
});

sync.get('/ping', (c) => {
  const total = db.prepare("SELECT COUNT(*) AS n FROM person WHERE status = 'active'")
    .get() as { n: number };
  return c.json({ ok: true, persons: total.n, linked: external.countBySource('sota') });
});

interface Incoming {
  source?: string;
  externalId: string | number;
  name: string;
  telegram?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  address?: string | null;
  birthday?: string | null;          // 12.05.1990 | 12.05 | 1990-05-12
  context?: string | null;           // обстоятельства знакомства
  circle?: number;                   // ставится только при создании
  tags?: string[];
  retireTags?: string[];             // теги, которые больше не актуальны («лид» после покупки)
  note?: string | null;
  interactions?: { on: string; channel?: Channel; summary?: string }[];
}

const clean = (s: string | null | undefined): string | null => {
  const v = (s ?? '').trim();
  return v || null;
};

/** Дописываем только пустое: ручная правка в «Круге» всегда главнее. */
function fillBlanks(p: Person, incoming: Record<string, string | null>): string[] {
  const set: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(incoming)) {
    if (!value) continue;
    if ((p as unknown as Record<string, unknown>)[field]) continue;
    set.push(`${field} = ?`);
    values.push(value);
  }
  if (!set.length) return [];
  db.prepare(`UPDATE person SET ${set.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...values, p.id);
  return set.map((s) => s.split(' ')[0]!);
}

sync.post('/person', async (c) => {
  const b = await c.req.json<Incoming>().catch(() => null);
  if (!b || !b.name?.trim() || b.externalId === undefined || b.externalId === null) {
    return c.json({ error: 'нужны name и externalId' }, 400);
  }

  const source = (b.source ?? 'sota').trim();
  const externalId = String(b.externalId);
  const changed: string[] = [];

  const contacts = {
    telegram: clean(b.telegram)?.replace(/^@/, '').toLowerCase() ?? null,
    phone: clean(b.phone),
    email: clean(b.email)?.toLowerCase() ?? null,
  };

  // 1. Кто это: уже связан → найден по контактам → новый.
  let personId = external.personIdFor(source, externalId);
  let created = false;

  if (!personId) {
    const matched = external.matchByContacts(contacts);
    if (matched) {
      personId = matched.id;
      changed.push('связан с существующим');
    } else {
      const circle = isCircle(Number(b.circle)) ? (Number(b.circle) as Circle) : 4;
      personId = people.create({
        name: b.name.trim(),
        circle,
        telegram: contacts.telegram,
        phone: contacts.phone,
        city: clean(b.city),
        met_context: clean(b.context),
        tags: (b.tags ?? []).map((t) => t.trim()).filter(Boolean),
      });
      created = true;
      changed.push('создан');
    }
  }

  const person = people.byId(personId);
  if (!person) return c.json({ error: 'человек потерялся' }, 500);

  // 2. Контакты и адрес — только в пустые поля.
  if (!created) {
    changed.push(...fillBlanks(person, {
      telegram: contacts.telegram,
      phone: contacts.phone,
      email: contacts.email,
      city: clean(b.city),
      met_context: clean(b.context),
    }));
  }
  changed.push(...fillBlanks(people.byId(personId)!, { address: clean(b.address) }));

  // 3. Теги — накапливаются, не затираются. Исключение: явно снятые внешней
  // системой (клиент купил — тег «лид» больше не про него).
  for (const t of b.retireTags ?? []) {
    const tag = t.trim().toLowerCase();
    if (!tag) continue;
    const info = db.prepare('DELETE FROM tag WHERE person_id = ? AND tag = ?').run(personId, tag);
    if (info.changes) changed.push(`снят тег ${tag}`);
  }

  const have = new Set(people.tagsOf(personId));
  for (const t of b.tags ?? []) {
    const tag = t.trim().toLowerCase();
    if (tag && !have.has(tag)) {
      people.addTag(personId, tag);
      changed.push(`тег ${tag}`);
    }
  }

  // 4. День рождения → повторяющееся событие.
  // В «Круге» год 1900 означает «год неизвестен», поэтому реальный год,
  // приехавший позже, уточняет уже созданное событие.
  const bd = b.birthday ? parseBirthday(b.birthday.trim()) : null;
  if (bd) {
    const existing = agenda.eventsOf(personId).find((e) => e.kind === 'birthday');
    if (!existing) {
      agenda.addEvent(personId, 'birthday', bd, { recurring: true });
      changed.push('день рождения');
    } else if (existing.event_date.startsWith('1900') && !bd.startsWith('1900')
               && existing.event_date.slice(4) === bd.slice(4)) {
      db.prepare('UPDATE event SET event_date = ? WHERE id = ?').run(bd, existing.id);
      changed.push('год рождения уточнён');
    }
  }

  // 5. Факты общения. Дубли отсекаем по (дата + текст): синхрон гоняется часто.
  const seen = db.prepare('SELECT happened_on, summary FROM interaction WHERE person_id = ?')
    .all(personId) as { happened_on: string; summary: string | null }[];
  const key = (on: string, s: string | null): string => `${on}|${s ?? ''}`;
  const known = new Set(seen.map((r) => key(r.happened_on, r.summary)));

  let added = 0;
  for (const it of b.interactions ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.on ?? '')) continue;
    const summary = clean(it.summary);
    if (known.has(key(it.on, summary))) continue;
    timeline.logInteraction(personId, it.channel ?? 'message', { on: it.on, summary: summary ?? undefined });
    known.add(key(it.on, summary));
    added++;
  }
  if (added) changed.push(`общение +${added}`);

  // 6. Заметка — одна, без повторов.
  const note = clean(b.note);
  if (note) {
    const dup = db.prepare('SELECT 1 FROM note WHERE person_id = ? AND body = ? LIMIT 1')
      .get(personId, note);
    if (!dup) {
      timeline.addNote(personId, note, 'import');
      changed.push('заметка');
    }
  }

  external.link(source, externalId, personId);
  people.reindex(personId);

  return c.json({ personId, created, changed });
});
