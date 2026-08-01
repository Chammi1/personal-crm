import type { Person } from '../db/types.js';
import { CIRCLES, intervalFor } from './circles.js';
import { addDays, daysBetween, nextOccurrence, today } from './dates.js';
import * as people from '../db/repo/people.js';
import * as timeline from '../db/repo/timeline.js';
import * as agenda from '../db/repo/agenda.js';
import * as collective from '../db/repo/collective.js';
import * as family from './family.js';

export type SignalKind = 'missed' | 'event' | 'owed' | 'risk' | 'late';

export interface Signal {
  person: Person;
  kind: SignalKind;
  why: string;
  /** дней до события; null для просрочек и долгов без срока */
  days: number | null;
  /** 0..1 — насколько крупной рисуется точка на карте */
  size: number;
  priority: number;
  eventId?: number;
  taskId?: number;
  /** коллективное событие: одно «✓ закрыть» гасит повод у всего кластера */
  collectiveId?: number;
  occurrence?: string;
}

/**
 * Рост точки события: медленно вдали от даты, резко в последнюю неделю.
 * Без этой нелинейности двадцать дней рождения в месяце превращаются в ровный шум.
 */
export function growth(daysLeft: number, leadDays: number): number {
  const t = Math.max(0, Math.min(1, 1 - daysLeft / leadDays));
  return Math.pow(t, 2.4);
}

/** Состояние связи: во сколько раз просрочен желаемый интервал. */
export function ratio(person: Person, lastOn: string | undefined, now: string): number {
  const interval = intervalFor(person.circle, person.target_interval);
  if (!lastOn) return 0; // дата неизвестна — это пробел в данных, а не сигнал
  return daysBetween(lastOn, now) / interval;
}

export function healthLabel(r: number): 'свежо' | 'скоро' | 'пора' | 'просрочка' | 'риск' {
  if (r < 0.7) return 'свежо';
  if (r < 1) return 'скоро';
  if (r < 1.5) return 'пора';
  if (r < 2.5) return 'просрочка';
  return 'риск';
}

export function collect(now = today()): Signal[] {
  const active = people.active();
  const byId = new Map(active.map((p) => [p.id, p]));
  const lastContact = timeline.lastContactMap();
  const snoozed = timeline.snoozedUntil();
  const out: Signal[] = [];

  const isSnoozed = (id: number): boolean => {
    const until = snoozed.get(id);
    return until !== undefined && daysBetween(now, until) > 0;
  };

  // --- события: дни рождения, годовщины, переезды
  //
  // Событие может висеть на карточке-заглушке — автосозданном родственнике.
  // Заглушек нет в active(), поэтому их поводы разрешаются через relation
  // на владельцев: день рождения ребёнка — повод написать родителю.
  // Имя и роль заглушки подставляются в формулировку без склонения.
  for (const e of agenda.allEvents()) {
    const direct = byId.get(e.person_id);
    const baseTitle = e.title ?? (e.kind === 'birthday' ? 'День рождения' : 'Событие');

    let carriers: { person: Person; title: string }[];
    if (direct) {
      carriers = [{ person: direct, title: baseTitle }];
    } else {
      const stub = people.byId(e.person_id);
      if (!stub || stub.is_stub !== 1 || stub.status !== 'active') continue;
      carriers = family.ownersOf(stub.id).map((o) => ({
        person: o.person,
        title: `${baseTitle}: ${o.label} ${stub.name}`,
      }));
    }

    for (const { person, title } of carriers) {
      if (isSnoozed(person.id)) continue;

      const next = nextOccurrence(e.event_date, e.recurring === 1, now);
      const left = daysBetween(now, next);

      if (left >= 0 && left <= e.lead_days && e.handled_for !== next) {
        out.push({
          person, kind: 'event', why: title, days: left,
          size: growth(left, e.lead_days),
          priority: 500 - left,
          eventId: e.id, occurrence: next,
        });
        continue;
      }

      // событие только что прошло и не было закрыто — это отдельный, более громкий сигнал
      if (e.recurring === 1) {
        const prev = nextOccurrence(e.event_date, true, addDays(now, -4));
        const passed = daysBetween(prev, now);
        if (passed > 0 && passed <= 4 && e.handled_for !== prev) {
          out.push({
            person, kind: 'missed', why: `${title} — прошёл ${passed} дн назад`,
            days: -passed, size: 1, priority: 900,
            eventId: e.id, occurrence: prev,
          });
        }
      } else if (left < 0 && left >= -4 && e.handled_for !== next) {
        out.push({
          person, kind: 'missed', why: `${title} — прошло ${-left} дн назад`,
          days: left, size: 1, priority: 900, eventId: e.id, occurrence: next,
        });
      }
    }
  }

  // --- коллективные события: один повод на весь кластер
  //
  // Сигнал получает каждый активный человек с тегом события (без тега — все).
  // Закрытие одно на всех: «поздравил клуб» гасит повод целиком.
  for (const ce of collective.all()) {
    const next = nextOccurrence(ce.event_date, ce.recurring === 1, now);
    const left = daysBetween(now, next);
    if (left < 0 || left > ce.lead_days || ce.handled_for === next) continue;

    const audience = ce.tag ? people.withTag(ce.tag) : active;
    for (const person of audience) {
      if (isSnoozed(person.id)) continue;
      out.push({
        person, kind: 'event',
        why: ce.title + (ce.tag ? ` · весь кластер #${ce.tag}` : ' · вся сеть'),
        days: left,
        size: growth(left, ce.lead_days),
        priority: 500 - left,
        collectiveId: ce.id, occurrence: next,
      });
    }
  }

  // --- обещания
  for (const t of agenda.openTasks()) {
    const person = byId.get(t.person_id);
    if (!person || isSnoozed(person.id)) continue;
    const left = t.due_on ? daysBetween(now, t.due_on) : null;
    if (left !== null && left > 3) continue;
    const overdue = left !== null && left < 0;
    out.push({
      person, kind: 'owed',
      why: (t.direction === 'i_owe' ? 'Ты обещал: ' : 'За ним: ') + t.body +
           (overdue ? ` (просрочено на ${-left} дн)` : ''),
      days: left, size: 1,
      priority: overdue ? 800 + Math.min(-left, 50) : 600,
      taskId: t.id,
    });
  }

  // --- тишина
  //
  // Люди без единого зафиксированного контакта сюда НЕ попадают.
  // Пока база размечается вручную, каждый новый человек иначе мгновенно
  // становился бы «риском» и топил дайджест. Такие люди — пробел в данных,
  // их место в /roster, а не в списке на сегодня.
  for (const person of active) {
    if (isSnoozed(person.id)) continue;
    const lastOn = lastContact.get(person.id);
    if (!lastOn) continue;
    const r = ratio(person, lastOn, now);
    if (r < 1) continue;
    const interval = intervalFor(person.circle, person.target_interval);
    const silent = daysBetween(lastOn, now);
    out.push({
      person,
      kind: r >= 2.5 ? 'risk' : 'late',
      why: `${silent} дн тишины при интервале в ${interval}`,
      days: null,
      size: 1,
      priority: (r >= 2.5 ? 300 : 200) + Math.min(Math.round(r * 10), 99),
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}

/** Сигналы, требующие действия прямо сейчас. Далёкие события сюда не попадают. */
export function due(signals: Signal[]): Signal[] {
  return signals.filter((s) => s.kind !== 'event' || (s.days !== null && s.days <= 5));
}

/** События, которые ещё только растут на горизонте. */
export function horizon(signals: Signal[]): Signal[] {
  return signals.filter((s) => s.kind === 'event' && s.days !== null && s.days > 5);
}

/** Переполнение кругов относительно ёмкости слоёв Данбара. */
export function circleLoad(): { circle: number; label: string; n: number; cap: number }[] {
  const counts = people.countsByCircle();
  return ([0, 1, 2, 3, 4] as const).map((c) => ({
    circle: c, label: CIRCLES[c].label, n: counts[c] ?? 0, cap: CIRCLES[c].cap,
  }));
}
