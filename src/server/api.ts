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

  return c.json({
    ...p,
    circleLabel: CIRCLES[p.circle].label,
    interval: intervalFor(p.circle, p.target_interval),
    tags: people.tagsOf(id),
    dossier: people.dossierOf(id) ?? null,
    lastOn: last?.happened_on ?? null,
    silent: last ? daysBetween(last.happened_on, now) : null,
    notes: timeline.notesOf(id, 8),
    events,
    tasks: agenda.tasksOf(id),
  });
});

api.post('/person', async (c) => {
  const b = await c.req.json<{
    name?: string; circle?: number; tags?: string[]; city?: string;
    telegram?: string; phone?: string; context?: string;
    birthday?: string; lastContact?: string;
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

  const bd = b.birthday ? parseBirthday(b.birthday) : null;
  if (bd) agenda.addEvent(id, 'birthday', bd, { recurring: true });

  if (b.lastContact) {
    timeline.logInteraction(id, 'message', { on: b.lastContact, summary: 'первичная разметка' });
  }

  return c.json({ id, intake: intake.state() });
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

api.get('/tags', (c) => {
  const rows = people.allTags();
  return c.json(rows);
});

api.get('/prompt', (c) => c.json({ prompt: intake.nextPrompt() }));
