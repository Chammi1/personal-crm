import { Hono } from 'hono';
import { CIRCLES, intervalFor, isCircle } from '../domain/circles.js';
import { addDays, daysBetween, nextOccurrence, today } from '../domain/dates.js';
import { parseBirthday } from '../domain/parse.js';
import * as signals from '../domain/signals.js';
import * as intake from '../domain/intake.js';
import * as people from '../db/repo/people.js';
import * as timeline from '../db/repo/timeline.js';
import * as agenda from '../db/repo/agenda.js';
import type { Channel } from '../db/types.js';
import { clusters, place, RING_RADIUS } from './layout.js';
import * as pets from '../db/repo/pets.js';
import * as family from '../domain/family.js';
import * as avatars from './avatars.js';

export const api = new Hono();

/** Всё, что нужно карте, одним запросом: узлы, сигналы, кластеры, прогресс. */
api.get('/state', (c) => {
  const now = today();
  const all = people.active();
  const { list, of } = clusters(all);
  const lastContact = timeline.lastContactMap();
  const collected = signals.collect(now);

  const strongest = new Map<number, signals.Signal>();
  for (const s of collected) {
    const prev = strongest.get(s.person.id);
    if (!prev || s.priority > prev.priority) strongest.set(s.person.id, s);
  }

  const nodes = all.map((p) => {
    const sector = of(p.id);
    const { x, y, angle } = place(p, sector, list.length);
    const lastOn = lastContact.get(p.id);
    const sig = strongest.get(p.id);
    return {
      id: p.id,
      name: p.name,
      circle: p.circle,
      sector,
      x, y, angle,
      lastOn: lastOn ?? null,
      silent: lastOn ? daysBetween(lastOn, now) : null,
      ratio: lastOn ? Number(signals.ratio(p, lastOn, now).toFixed(2)) : null,
      health: lastOn ? signals.healthLabel(signals.ratio(p, lastOn, now)) : null,
      signal: sig ? { kind: sig.kind, why: sig.why, days: sig.days, size: Number(sig.size.toFixed(3)) } : null,
    };
  });

  const due = signals.due(collected);
  const horizon = signals.horizon(collected);

  return c.json({
    today: now,
    rings: RING_RADIUS.map((r, i) => ({ r, circle: i, label: CIRCLES[i as 0].label, cap: CIRCLES[i as 0].cap })),
    clusters: list,
    nodes,
    counts: { total: all.length, due: due.length, horizon: horizon.length },
    intake: intake.state(),
    circleLoad: signals.circleLoad(),
  });
});

/**
 * Полный справочник для вкладки «Разметка»: все активные люди с полями,
 * по которым удобно фильтровать — город, теги, род деятельности из досье.
 * Фильтрация происходит на клиенте: базы до тысячи человек это позволяет.
 */
api.get('/people', (c) => {
  const now = today();
  const lastContact = timeline.lastContactMap();
  const list = people.active().map((p) => {
    const lastOn = lastContact.get(p.id) ?? null;
    return {
      id: p.id,
      name: p.name,
      circle: p.circle,
      city: p.city,
      avatar: p.avatar,
      tags: people.tagsOf(p.id),
      occupation: people.dossierOf(p.id)?.occupation ?? null,
      lastOn,
      silent: lastOn ? daysBetween(lastOn, now) : null,
      health: lastOn ? signals.healthLabel(signals.ratio(p, lastOn, now)) : null,
    };
  });
  return c.json(list);
});

api.get('/person/:id', (c) => {
  const id = Number(c.req.param('id'));
  const p = people.byId(id);
  if (!p) return c.json({ error: 'not found' }, 404);

  const now = today();
  const last = timeline.lastInteraction(id);
  const events = agenda.eventsOf(id).map((e) => {
    const next = nextOccurrence(e.event_date, e.recurring === 1, now);
    return {
      id: e.id,
      title: e.title ?? (e.kind === 'birthday' ? 'День рождения' : 'Событие'),
      date: e.event_date, next, days: daysBetween(now, next), recurring: e.recurring === 1,
    };
  });

  // Семья с датами рождения: возраст считается из года (1900 = год неизвестен),
  // а до дня рождения — дни через ближайшее наступление.
  const familyView = family.familyOf(id).map((m) => {
    const bd = agenda.eventsOf(m.id).find((e) => e.kind === 'birthday');
    let age: number | null = null;
    let bdDays: number | null = null;
    let bdOn: string | null = null;
    if (bd) {
      bdOn = bd.event_date;
      const next = nextOccurrence(bd.event_date, true, now);
      bdDays = daysBetween(now, next);
      const year = Number(bd.event_date.slice(0, 4));
      if (year > 1900) {
        age = Number(next.slice(0, 4)) - year - (bdDays === 0 ? 0 : 1);
      }
    }
    return { ...m, birthday: bdOn, birthdayDays: bdDays, age };
  });

  return c.json({
    ...p,
    circleLabel: CIRCLES[p.circle].label,
    family: familyView,
    pets: pets.ofOwner(id),
    interval: intervalFor(p.circle, p.target_interval),
    tags: people.tagsOf(id),
    dossier: people.dossierOf(id) ?? null,
    lastOn: last?.happened_on ?? null,
    silent: last ? daysBetween(last.happened_on, now) : null,
    notes: timeline.notesOf(id, 8),
    interactions: timeline.interactionsOf(id, 40).map((i) => ({
      id: i.id, on: i.happened_on, channel: i.channel, summary: i.summary,
    })),
    events,
    tasks: agenda.tasksOf(id),
  });
});

api.post('/person', async (c) => {
  const b = await c.req.json<{
    name?: string; circle?: number; tags?: string[]; city?: string;
    telegram?: string; phone?: string; context?: string;
    birthday?: string; lastContact?: string;
    // расширенная форма-визард: досье и оценка сразу при добавлении
    occupation?: string; hooks?: string; dreams?: string; familyNote?: string;
    rapport?: number;
  }>();

  const name = (b.name ?? '').trim();
  if (!name) return c.json({ error: 'нужно имя' }, 400);

  const circle = isCircle(Number(b.circle)) ? (Number(b.circle) as 0) : 3;
  const id = people.create({
    name, circle,
    city: b.city?.trim() || null,
    telegram: b.telegram?.replace(/^@/, '').trim() || null,
    phone: b.phone?.trim() || null,
    met_on: today(),
    met_context: b.context?.trim() || null,
    tags: (b.tags ?? []).map((t) => t.trim()).filter(Boolean),
  });

  const dossier: Record<string, string> = {};
  if (b.occupation?.trim()) dossier['occupation'] = b.occupation.trim();
  if (b.hooks?.trim()) dossier['hooks'] = b.hooks.trim();
  if (b.dreams?.trim()) dossier['dreams'] = b.dreams.trim();
  if (b.familyNote?.trim()) dossier['family'] = b.familyNote.trim();
  if (Object.keys(dossier).length) people.setDossier(id, dossier);

  if (b.rapport && b.rapport >= 1 && b.rapport <= 5) people.update(id, { rapport: b.rapport });

  const bd = b.birthday ? parseBirthday(b.birthday) : null;
  if (bd) agenda.addEvent(id, 'birthday', bd, { recurring: true });

  if (b.lastContact) {
    timeline.logInteraction(id, 'message', { on: b.lastContact, summary: 'первичная разметка' });
  }

  return c.json({ id, intake: intake.state() });
});

api.patch('/person/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!people.byId(id)) return c.json({ error: 'not found' }, 404);

  const b = await c.req.json<{
    name?: string; circle?: number; city?: string; telegram?: string; phone?: string;
    context?: string; interval?: number | null; tags?: string[];
    dossier?: Record<string, string>; lastContact?: string; rapport?: number | null;
  }>();

  if (b.name !== undefined && !b.name.trim()) return c.json({ error: 'имя не может быть пустым' }, 400);

  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch['name'] = b.name.trim();
  if (b.city !== undefined) patch['city'] = b.city.trim();
  if (b.telegram !== undefined) patch['telegram'] = b.telegram.replace(/^@/, '').trim();
  if (b.phone !== undefined) patch['phone'] = b.phone.trim();
  if (b.context !== undefined) patch['met_context'] = b.context.trim();
  // 0 и null сбрасывают оценку, значения вне 1..5 просто игнорируются,
  // чтобы опечатка не стёрла уже выставленную.
  if (b.rapport === null || b.rapport === 0) patch['rapport'] = null;
  else if (b.rapport !== undefined && b.rapport >= 1 && b.rapport <= 5) patch['rapport'] = b.rapport;
  if (b.interval !== undefined) patch['target_interval'] = b.interval || null;
  people.update(id, patch);

  if (b.circle !== undefined && isCircle(Number(b.circle))) people.setCircle(id, Number(b.circle) as 0);
  if (b.tags !== undefined) people.setTags(id, b.tags);
  if (b.dossier !== undefined) people.setDossier(id, b.dossier);

  // Дата последнего общения правится через добавление контакта задним числом:
  // так не теряется история, а last_contact всё так же выводится из неё.
  if (b.lastContact) {
    timeline.logInteraction(id, 'message', { on: b.lastContact, summary: 'правка даты' });
  }

  return c.json({ ok: true });
});

api.post('/person/:id/archive', (c) => {
  const id = Number(c.req.param('id'));
  people.setStatus(id, 'archived');
  return c.json({ ok: true });
});

api.post('/person/:id/restore', (c) => {
  const id = Number(c.req.param('id'));
  people.setStatus(id, 'active');
  return c.json({ ok: true });
});

api.delete('/person/:id', (c) => {
  const id = Number(c.req.param('id'));
  const p = people.byId(id);
  if (!p) return c.json({ error: 'not found' }, 404);
  // Файлы аватаров — самого человека и его питомцев — вычищаются вместе
  // с записью: строки питомцев каскадом удалит база, файлы сами не исчезнут.
  if (p.avatar) avatars.remove(p.avatar);
  for (const pet of pets.ofOwner(id)) {
    if (pet.avatar) avatars.remove(pet.avatar);
  }
  people.remove(id);
  return c.json({ ok: true });
});

api.get('/archived', (c) => c.json(people.archived().map((p) => ({ id: p.id, name: p.name, circle: p.circle }))));

api.post('/person/:id/event', async (c) => {
  const id = Number(c.req.param('id'));
  const b = await c.req.json<{ date?: string; title?: string; recurring?: boolean }>();
  const date = b.date ? parseBirthday(b.date) : null;
  if (!date) return c.json({ error: 'дата в формате 12.04 или 12.04.1991' }, 400);
  const title = b.title?.trim() || 'День рождения';
  agenda.addEvent(id, /рожд/i.test(title) ? 'birthday' : 'custom', date, {
    title, recurring: b.recurring ?? true,
  });
  return c.json({ ok: true });
});

api.delete('/event/:id', (c) => {
  agenda.removeEvent(Number(c.req.param('id')));
  return c.json({ ok: true });
});

api.delete('/task/:id', (c) => {
  agenda.removeTask(Number(c.req.param('id')));
  return c.json({ ok: true });
});

api.post('/person/:id/contact', async (c) => {
  const id = Number(c.req.param('id'));
  const b = await c.req.json<{ channel?: Channel; on?: string }>()
    .catch((): { channel?: Channel; on?: string } => ({}));
  timeline.logInteraction(id, b.channel ?? 'message', { on: b.on });
  return c.json({ ok: true });
});

api.post('/person/:id/note', async (c) => {
  const id = Number(c.req.param('id'));
  const { body } = await c.req.json<{ body?: string }>();
  if (!body?.trim()) return c.json({ error: 'пустая заметка' }, 400);
  timeline.addNote(id, body.trim());
  return c.json({ ok: true });
});

api.post('/person/:id/circle', async (c) => {
  const id = Number(c.req.param('id'));
  const { circle } = await c.req.json<{ circle?: number }>();
  if (!isCircle(Number(circle))) return c.json({ error: 'круг 0..4' }, 400);
  people.setCircle(id, Number(circle) as 0);
  return c.json({ ok: true });
});

api.post('/person/:id/snooze', async (c) => {
  const id = Number(c.req.param('id'));
  const { days } = await c.req.json<{ days?: number }>()
    .catch((): { days?: number } => ({ days: 7 }));
  timeline.snooze(id, addDays(today(), Number(days) || 7));
  return c.json({ ok: true });
});

api.post('/person/:id/task', async (c) => {
  const id = Number(c.req.param('id'));
  const b = await c.req.json<{ body?: string; direction?: 'i_owe' | 'they_owe'; due?: string }>();
  if (!b.body?.trim()) return c.json({ error: 'пустое обещание' }, 400);
  agenda.addTask(id, b.direction ?? 'i_owe', b.body.trim(), b.due || null);
  return c.json({ ok: true });
});

api.post('/task/:id/close', (c) => {
  agenda.closeTask(Number(c.req.param('id')));
  return c.json({ ok: true });
});

/* ---------- аватары ---------- */

api.post('/person/:id/avatar', async (c) => {
  const id = Number(c.req.param('id'));
  if (!people.byId(id)) return c.json({ error: 'not found' }, 404);
  const { data } = await c.req.json<{ data?: string }>();
  const file = data ? avatars.save('p', id, data) : null;
  if (!file) return c.json({ error: 'картинка не принята: нужен jpeg/png до 400 КБ' }, 400);
  people.setAvatar(id, file);
  return c.json({ avatar: file });
});

api.post('/pet/:id/avatar', async (c) => {
  const id = Number(c.req.param('id'));
  if (!pets.byId(id)) return c.json({ error: 'not found' }, 404);
  const { data } = await c.req.json<{ data?: string }>();
  const file = data ? avatars.save('pet', id, data) : null;
  if (!file) return c.json({ error: 'картинка не принята' }, 400);
  pets.setAvatar(id, file);
  return c.json({ avatar: file });
});

/* ---------- питомцы ---------- */

api.post('/person/:id/pet', async (c) => {
  const ownerId = Number(c.req.param('id'));
  if (!people.byId(ownerId)) return c.json({ error: 'not found' }, 404);

  const b = await c.req.json<{
    name?: string; species?: string; breed?: string; birthday?: string; note?: string;
  }>();
  if (!b.name?.trim()) return c.json({ error: 'нужна кличка' }, 400);

  const birthday = b.birthday ? parseBirthday(b.birthday) : null;
  const petId = pets.create(ownerId, {
    name: b.name.trim(), species: b.species?.trim() || null,
    breed: b.breed?.trim() || null, birthday, note: b.note?.trim() || null,
  });

  // Дата питомца — это повод написать хозяину, поэтому событие вешается на владельца.
  // Горизонт не задаётся здесь жёстко: берётся общий default из настроек (/lead).
  if (birthday) {
    agenda.addEvent(ownerId, 'custom', birthday, {
      title: `День рождения ${b.name.trim()}${b.species ? ' (' + b.species.trim() + ')' : ''}`,
      recurring: true, petId,
    });
  }
  return c.json({ id: petId });
});

api.patch('/pet/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!pets.byId(id)) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json<{ name?: string; species?: string; breed?: string; note?: string }>();
  pets.update(id, b);
  return c.json({ ok: true });
});

api.delete('/pet/:id', (c) => {
  const pet = pets.byId(Number(c.req.param('id')));
  if (!pet) return c.json({ error: 'not found' }, 404);
  if (pet.avatar) avatars.remove(pet.avatar);
  pets.remove(pet.id);
  return c.json({ ok: true });
});

/* ---------- семья ---------- */

api.post('/person/:id/family', async (c) => {
  const id = Number(c.req.param('id'));
  if (!people.byId(id)) return c.json({ error: 'not found' }, 404);

  const b = await c.req.json<{ name?: string; role?: family.FamilyRole; birthday?: string; existingId?: number }>();
  if (!b.role) return c.json({ error: 'нужна роль' }, 400);

  // Если человек уже есть в базе — связываем, а не плодим дубль.
  if (b.existingId) {
    family.link(id, Number(b.existingId), b.role);
    family.rebuildDerived(id);
    return c.json({ id: Number(b.existingId), created: false });
  }

  if (!b.name?.trim()) return c.json({ error: 'нужно имя' }, 400);
  const memberId = family.addMember(id, { name: b.name, role: b.role });

  const bd = b.birthday ? parseBirthday(b.birthday) : null;
  if (bd) agenda.addEvent(memberId, 'birthday', bd, { recurring: true });

  return c.json({ id: memberId, created: true });
});

api.delete('/person/:id/family/:memberId', (c) => {
  const id = Number(c.req.param('id'));
  const memberId = Number(c.req.param('memberId'));
  family.unlink(id, memberId);
  family.rebuildDerived(id);
  return c.json({ ok: true });
});

api.post('/person/:id/activate', async (c) => {
  const id = Number(c.req.param('id'));
  const { circle } = await c.req.json<{ circle?: number }>().catch((): { circle?: number } => ({}));
  family.activate(id, isCircle(Number(circle)) ? Number(circle) : 3);
  return c.json({ ok: true });
});

api.get('/tags', (c) => {
  const rows = people.allTags();
  return c.json(rows);
});

api.get('/prompt', (c) => c.json({ prompt: intake.nextPrompt() }));
