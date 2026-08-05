import { db } from '../index.js';
import { addDays, today } from '../../domain/dates.js';
import type { EventKind, PersonEvent, Task, TaskDirection } from '../types.js';
import * as settings from './settings.js';

/**
 * За сколько дней повод начинает проявляться. Одно значение на все виды
 * событий — и людей, и питомцев; меняется командой /lead.
 */
export const LEAD_DAYS_KEY = 'lead_days';
export const LEAD_DAYS_DEFAULT = 30;

export function leadDaysDefault(): number {
  return settings.getNumber(LEAD_DAYS_KEY, LEAD_DAYS_DEFAULT);
}

export function addEvent(
  personId: number,
  kind: EventKind,
  eventDate: string,
  opts: { title?: string; recurring?: boolean; leadDays?: number; petId?: number } = {},
): number {
  const info = db.prepare(`
    INSERT INTO event (person_id, kind, title, event_date, recurring, lead_days, pet_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    personId, kind, opts.title ?? null, eventDate,
    // SQLite не биндит boolean — приводим к 0/1 явно
    opts.recurring === undefined ? (kind === 'birthday' ? 1 : 0) : (opts.recurring ? 1 : 0),
    opts.leadDays ?? leadDaysDefault(),
    opts.petId ?? null,
  );
  return Number(info.lastInsertRowid);
}

export function allEvents(): PersonEvent[] {
  return db.prepare(`
    SELECT e.* FROM event e
    JOIN person p ON p.id = e.person_id
    WHERE p.status = 'active'
  `).all() as PersonEvent[];
}

export function eventsOf(personId: number): PersonEvent[] {
  return db.prepare('SELECT * FROM event WHERE person_id = ?').all(personId) as PersonEvent[];
}

/** Помечает конкретное наступление события закрытым, чтобы оно не всплывало снова в этом году. */
export function markEventHandled(eventId: number, occurrenceDate: string): void {
  db.prepare('UPDATE event SET handled_for = ? WHERE id = ?').run(occurrenceDate, eventId);
}

/**
 * Смена горизонта разом у всех событий. Per-event значение нигде из
 * интерфейса не выставляется, поэтому массовое обновление ничего не теряет.
 */
export function setAllLeadDays(days: number): void {
  db.prepare('UPDATE event SET lead_days = ?').run(days);
}

export function removeEvent(id: number): void {
  db.prepare('DELETE FROM event WHERE id = ?').run(id);
}

export function removeTask(id: number): void {
  db.prepare('DELETE FROM task WHERE id = ?').run(id);
}

/** Мягкий срок по умолчанию: обещание без даты напомнит о себе через ~2 недели. */
export const AUTO_DUE_DAYS = 14;

/**
 * Бессрочных обещаний не бывает: без явной даты ставится автосрок +14 дней
 * (помечен due_auto), иначе обещание никогда не дозревало бы до owed-сигнала
 * и молча тонуло. Правило общее для всех путей создания: бот, мини-апп, голос.
 */
export function addTask(
  personId: number,
  direction: TaskDirection,
  body: string,
  dueOn: string | null = null,
): number {
  const auto = dueOn === null;
  const due = dueOn ?? addDays(today(), AUTO_DUE_DAYS);
  const info = db.prepare(
    'INSERT INTO task (person_id, direction, body, due_on, due_auto) VALUES (?, ?, ?, ?, ?)',
  ).run(personId, direction, body, due, auto ? 1 : 0);
  return Number(info.lastInsertRowid);
}

export function openTasks(): Task[] {
  return db.prepare(`
    SELECT t.* FROM task t
    JOIN person p ON p.id = t.person_id
    WHERE t.done_at IS NULL AND p.status = 'active'
    ORDER BY COALESCE(t.due_on, '9999-12-31')
  `).all() as Task[];
}

export function tasksOf(personId: number): Task[] {
  return db.prepare(
    'SELECT * FROM task WHERE person_id = ? AND done_at IS NULL ORDER BY COALESCE(due_on, \'9999-12-31\')',
  ).all(personId) as Task[];
}

export function closeTask(id: number): void {
  db.prepare('UPDATE task SET done_at = ? WHERE id = ?').run(today(), id);
}
