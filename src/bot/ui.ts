import { InlineKeyboard } from 'grammy';
import type { Person } from '../db/types.js';
import { CIRCLES, intervalFor } from '../domain/circles.js';
import { dayMonth, daysBetween, humanDate, humanDays, plural, today } from '../domain/dates.js';
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
      const year = e.recurring && !e.event_date.startsWith('1900') ? `, ${e.event_date.slice(0, 4)} г.р.` : '';
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

  const keyboard = new InlineKeyboard();
  shown.forEach((s, i) => {
    keyboard.text(`${i + 1}. ${s.person.name.split(' ')[0]}`, `p:${s.person.id}`);
    if (i % 2 === 1) keyboard.row();
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
