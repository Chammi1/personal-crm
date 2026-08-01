import { InlineKeyboard } from 'grammy';
import type { Person } from '../db/types.js';
import { CIRCLES, intervalFor } from '../domain/circles.js';
import { addDays, dayMonth, daysBetween, humanDate, humanDays, nextOccurrence, plural, today } from '../domain/dates.js';
import { healthLabel, ratio, type Signal, type SignalKind } from '../domain/signals.js';
import * as people from '../db/repo/people.js';
import * as timeline from '../db/repo/timeline.js';
import * as agenda from '../db/repo/agenda.js';

export const MARK: Record<SignalKind, string> = {
  missed: '🔴', event: '🟣', owed: '🟡', risk: '🔴', late: '🟠',
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function personCard(id: number): { text: string; keyboard: InlineKeyboard } | null {
  const p = people.byId(id);
  if (!p) return null;

  const d = people.dossierOf(id);
  const tags = people.tagsOf(id);
  const last = timeline.lastInteraction(id);
  const now = today();
  const r = ratio(p, last?.happened_on, now);

  const lines: string[] = [];
  lines.push(`<b>${esc(p.name)}</b>`);

  const head = [`круг ${p.circle} · ${CIRCLES[p.circle].label}`];
  if (p.city) head.push(esc(p.city));
  if (p.telegram) head.push('@' + esc(p.telegram));
  lines.push(`<i>${head.join(' · ')}</i>`);

  const interval = intervalFor(p.circle, p.target_interval);
  lines.push(
    last
      ? `Контакт: ${humanDate(last.happened_on)} — ${daysBetween(last.happened_on, now)} дн назад · ${healthLabel(r)} (норма ${interval} дн)`
      : `Контакт: не зафиксирован · норма ${interval} дн`,
  );
  if (tags.length) lines.push(`Теги: ${tags.map(esc).join(', ')}`);
  if (p.met_context) lines.push(`Знакомство: ${esc(p.met_context)}${p.met_on ? ', ' + humanDate(p.met_on) : ''}`);
  // связи по знакомству: кто представил и кого привёл сам
  if (p.met_via) {
    const via = people.byId(p.met_via);
    if (via) lines.push(`Представил: ${esc(via.name)}`);
  }
  const brought = people.introduced(id);
  if (brought.length) {
    lines.push(`Привёл в сеть ${brought.length}: ${brought.slice(0, 5).map((b) => esc(b.name.split(' ')[0]!)).join(', ')}${brought.length > 5 ? '…' : ''}`);
  }

  const dossierBlocks: [string, string | null | undefined][] = [
    ['Семья', d?.family], ['Работа', d?.occupation], ['Увлечения', d?.recreation],
    ['Планы', d?.dreams], ['Зацепки', d?.hooks], ['Не трогать', d?.avoid], ['Подарки', d?.gift_ideas],
  ];
  const filled = dossierBlocks.filter(([, v]) => v);
  if (filled.length) {
    lines.push('', '<b>Помнить</b>');
    for (const [label, value] of filled) lines.push(`<b>${label}:</b> ${esc(value!)}`);
  } else {
    lines.push('', '<i>Досье пустое. Заполни блоки FORD: /f семья | работа | увлечения | планы</i>');
  }

  const events = agenda.eventsOf(id);
  if (events.length) {
    lines.push('', '<b>Даты</b>');
    for (const e of events) {
      const title = e.title ?? (e.kind === 'birthday' ? 'День рождения' : 'Событие');
      const when = e.recurring ? dayMonth(e.event_date) : humanDate(e.event_date);
      // «г.р.» — только про рождение; у годовщины год означает «с какого года»
      const y = e.event_date.slice(0, 4);
      const year = e.recurring === 1 && y !== '1900' ? (e.kind === 'birthday' ? `, ${y} г.р.` : `, с ${y}`) : '';
      lines.push(`${title} — ${when}${year}`);
    }
  }

  const tasks = agenda.tasksOf(id);
  if (tasks.length) {
    lines.push('', '<b>Обязательства</b>');
    for (const t of tasks) {
      lines.push(`${t.direction === 'i_owe' ? 'Ты:' : 'Он:'} ${esc(t.body)}${t.due_on ? ' — до ' + humanDate(t.due_on) : ''}`);
    }
  }

  const notes = timeline.notesOf(id, 3);
  if (notes.length) {
    lines.push('', '<b>Последнее</b>');
    for (const n of notes) lines.push(`${humanDate(n.written_on)}: ${esc(n.body)}`);
  }

  const keyboard = new InlineKeyboard()
    .text('Написал', `c:${id}:message`).text('Позвонил', `c:${id}:call`).text('Встретились', `c:${id}:meeting`)
    .row()
    .text('Заметка', `n:${id}`).text('Обещание', `t:${id}`).text('Дата', `e:${id}`)
    .row()
    .text('Отложить 7 дн', `sn:${id}:7`).text('Круг', `cr:${id}`);

  // Кнопки закрытия активных поводов: событие в горизонте или только что
  // прошедшее, незакрытые обещания. Без них handled_for некому выставить,
  // и «пропущено» висит наверху дайджеста 4 дня после поздравления.
  const cut = (s: string): string => (s.length > 24 ? s.slice(0, 23) + '…' : s);
  for (const e of events) {
    const title = e.title ?? (e.kind === 'birthday' ? 'День рождения' : 'Событие');
    const next = nextOccurrence(e.event_date, e.recurring === 1, now);
    const left = daysBetween(now, next);
    if (left >= 0 && left <= e.lead_days && e.handled_for !== next) {
      keyboard.row().text(`✓ ${cut(title)} — закрыть`, `ev:${e.id}:${next}`);
    } else if (e.recurring === 1) {
      const prev = nextOccurrence(e.event_date, true, addDays(now, -4));
      const passed = daysBetween(prev, now);
      if (passed > 0 && passed <= 4 && e.handled_for !== prev) {
        keyboard.row().text(`✓ ${cut(title)} — закрыть`, `ev:${e.id}:${prev}`);
      }
    } else if (left < 0 && left >= -4 && e.handled_for !== next) {
      keyboard.row().text(`✓ ${cut(title)} — закрыть`, `ev:${e.id}:${next}`);
    }
  }
  for (const t of tasks.slice(0, 3)) {
    keyboard.row().text(`✓ ${cut(t.body)} — сделано`, `tk:${t.id}`);
  }

  return { text: lines.join('\n'), keyboard };
}

export function signalLine(s: Signal, index: number): string {
  const tail = s.kind === 'event' && s.days !== null ? ` — ${humanDays(s.days)}` : '';
  return `${index}. ${MARK[s.kind]} <b>${esc(s.person.name)}</b> — ${esc(s.why)}${tail}`;
}

export function digest(
  dueList: Signal[],
  horizonList: Signal[],
  dateLabel: string,
  intakeTail?: string,
): { text: string; keyboard: InlineKeyboard } {
  const lines: string[] = [`<b>${dateLabel}</b>`];

  if (!dueList.length && !horizonList.length) {
    lines.push('', 'Круг чист: ни одного повода.', 'Хороший день, чтобы написать кому-нибудь просто так — /stats покажет, кто давно не появлялся.');
    if (intakeTail) lines.push('', intakeTail);
    return { text: lines.join('\n'), keyboard: new InlineKeyboard() };
  }

  const n = dueList.length;
  lines.push(`${n} ${plural(n, 'человек ждёт', 'человека ждут', 'человек ждут')}` +
    (horizonList.length ? ` · ${horizonList.length} на горизонте` : ''));

  const shown = dueList.slice(0, 8);
  if (shown.length) {
    lines.push('');
    shown.forEach((s, i) => lines.push(signalLine(s, i + 1)));
  }
  if (dueList.length > shown.length) {
    lines.push(`<i>…и ещё ${dueList.length - shown.length}. Разгребай сверху, остальное подождёт.</i>`);
  }

  if (horizonList.length) {
    lines.push('', '<b>Подходит</b>');
    for (const s of horizonList.slice(0, 5)) {
      lines.push(`${esc(s.person.name)} — ${esc(s.why)}, ${humanDays(s.days!)}`);
    }
  }

  if (intakeTail) lines.push('', intakeTail);

  // По строке на позицию: открыть карточку, записать контакт, закрыть повод —
  // всё из дайджеста, не проваливаясь в карточку.
  const keyboard = new InlineKeyboard();
  shown.forEach((s, i) => {
    keyboard.text(`${i + 1}. ${s.person.name.split(' ')[0]}`, `p:${s.person.id}`);
    keyboard.text('✍', `c:${s.person.id}:message`);
    if (s.eventId && s.occurrence) keyboard.text('✓ закрыть', `ev:${s.eventId}:${s.occurrence}`);
    else if (s.collectiveId && s.occurrence) keyboard.text('✓ для всех', `cev:${s.collectiveId}:${s.occurrence}`);
    else if (s.taskId) keyboard.text('✓ сделано', `tk:${s.taskId}`);
    keyboard.row();
  });

  return { text: lines.join('\n'), keyboard };
}

export function searchResults(list: Person[]): { text: string; keyboard: InlineKeyboard } {
  if (!list.length) {
    return {
      text: 'Никого не нашёл. Добавить нового: <code>/add Имя Фамилия #тег круг:2</code>',
      keyboard: new InlineKeyboard(),
    };
  }
  const keyboard = new InlineKeyboard();
  list.forEach((p, i) => {
    keyboard.text(`${p.name} · ${p.circle}`, `p:${p.id}`);
    if (i % 2 === 1) keyboard.row();
  });
  return { text: `Нашёл ${list.length}:`, keyboard };
}
