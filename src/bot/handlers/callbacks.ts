import { Composer, InlineKeyboard, type Context } from 'grammy';
import { CIRCLES, isCircle } from '../../domain/circles.js';
import { addDays, today } from '../../domain/dates.js';
import { parseBirthday } from '../../domain/parse.js';
import type { Channel } from '../../db/types.js';
import * as people from '../../db/repo/people.js';
import * as timeline from '../../db/repo/timeline.js';
import * as agenda from '../../db/repo/agenda.js';
import * as ui from '../ui.js';
import { clearPending, setCurrent, setPending } from '../state.js';

export const callbacks = new Composer();

async function showCard(ctx: Context, id: number, edit = false): Promise<void> {
  const card = ui.personCard(id);
  if (!card) { await ctx.answerCallbackQuery('Человек не найден'); return; }
  setCurrent(id);
  if (edit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(card.text, { parse_mode: 'HTML', reply_markup: card.keyboard });
  } else {
    await ctx.reply(card.text, { parse_mode: 'HTML', reply_markup: card.keyboard });
  }
}

callbacks.callbackQuery(/^p:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showCard(ctx, Number(ctx.match[1]));
});

const CHANNEL_WORD: Record<Channel, string> = {
  message: 'Переписка', call: 'Звонок', meeting: 'Встреча', event: 'Общее мероприятие',
};

callbacks.callbackQuery(/^c:(\d+):(message|call|meeting|event)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const channel = ctx.match[2] as Channel;
  timeline.logInteraction(id, channel);
  await ctx.answerCallbackQuery(`${CHANNEL_WORD[channel]} записана`);
  await showCard(ctx, id, true);

  // Сразу спрашиваем содержание: без этого копится идеальная история дат
  // при пустой истории разговоров, а перед звонком нужна именно вторая.
  setPending({ type: 'contact_note', personId: id });
  await ctx.reply('О чём говорили? Одной строкой — уйдёт в заметки.', {
    reply_markup: new InlineKeyboard().text('Пропустить', 'skipnote'),
  });
});

callbacks.callbackQuery('skipnote', async (ctx) => {
  clearPending();
  await ctx.answerCallbackQuery('Ок');
  if (ctx.callbackQuery.message) {
    await ctx.editMessageText('Ок, без заметки.');
  }
});

callbacks.callbackQuery(/^sn:(\d+):(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const days = Number(ctx.match[2]);
  timeline.snooze(id, addDays(today(), days));
  await ctx.answerCallbackQuery(`Скрыт на ${days} дн`);
});

callbacks.callbackQuery(/^n:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  setPending({ type: 'note', personId: id });
  await ctx.answerCallbackQuery();
  await ctx.reply('Что записать? Пиши свободным текстом.');
});

callbacks.callbackQuery(/^t:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  setPending({ type: 'task', personId: id });
  await ctx.answerCallbackQuery();
  await ctx.reply(
    'Обещание. Формат: <code>я скинуть контакт юриста до 30.07</code>\n' +
    'Начни с «я» или «он», срок через «до» — необязательно.',
    { parse_mode: 'HTML' },
  );
});

callbacks.callbackQuery(/^e:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  setPending({ type: 'event', personId: id });
  await ctx.answerCallbackQuery();
  await ctx.reply(
    'Дата. Формат: <code>12.04 День рождения</code> или <code>2026-08-03 Переезд в Алматы</code>\n' +
    'Без года — считаю ежегодной.',
    { parse_mode: 'HTML' },
  );
});

callbacks.callbackQuery(/^cr:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const kb = new InlineKeyboard();
  ([0, 1, 2, 3, 4] as const).forEach((c, i) => {
    kb.text(`${c} · ${CIRCLES[c].label}`, `cr:${id}:${c}`);
    if (i % 2 === 1) kb.row();
  });
  await ctx.answerCallbackQuery();
  await ctx.reply('В какой круг?', { reply_markup: kb });
});

callbacks.callbackQuery(/^cr:(\d+):(\d)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const c = Number(ctx.match[2]);
  if (!isCircle(c)) { await ctx.answerCallbackQuery('Неизвестный круг'); return; }
  people.setCircle(id, c);
  await ctx.answerCallbackQuery(`Круг ${c} · ${CIRCLES[c].label}`);
  await showCard(ctx, id);
});

callbacks.callbackQuery(/^ev:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  agenda.markEventHandled(Number(ctx.match[1]), ctx.match[2]!);
  await ctx.answerCallbackQuery('Закрыто — в этом году больше не всплывёт');
});

callbacks.callbackQuery(/^tk:(\d+)$/, async (ctx) => {
  agenda.closeTask(Number(ctx.match[1]));
  await ctx.answerCallbackQuery('Обещание закрыто');
});

/** Обработка свободного ввода, которого ждала одна из кнопок. */
export async function handlePendingInput(
  ctx: Context,
  pending: { type: 'note' | 'task' | 'event' | 'contact_note'; personId: number },
  text: string,
): Promise<void> {
  const id = pending.personId;

  if (pending.type === 'note' || pending.type === 'contact_note') {
    timeline.addNote(id, text);
    await ctx.reply('Записал.');
    // после записи контакта карточка уже на экране — не дублируем её
    if (pending.type === 'contact_note') return;
  }

  if (pending.type === 'task') {
    const dueMatch = text.match(/\sдо\s+(\S+)$/i);
    const dueRaw = dueMatch ? parseBirthday(dueMatch[1]!) : null;
    // Бот сам предлагает формат «до 30.07» — без года. Парсер вернёт 1900,
    // и без нормализации срок молча терялся, обещание висело бессрочным.
    let due: string | null = null;
    if (dueRaw) {
      due = dueRaw.startsWith('1900') ? String(new Date().getFullYear()) + dueRaw.slice(4) : dueRaw;
      if (due < today()) due = String(Number(due.slice(0, 4)) + 1) + due.slice(4);
    }
    const body = (dueMatch ? text.slice(0, dueMatch.index) : text)
      .replace(/^(я|он|она|они)\s+/i, '').trim();
    const direction = /^(я)\b/i.test(text) ? 'i_owe' : /^(он|она|они)\b/i.test(text) ? 'they_owe' : 'i_owe';
    agenda.addTask(id, direction, body, due);
    await ctx.reply(due ? `Обещание записано, срок — ${due.split('-').reverse().join('.')}.` : 'Обещание записано.');
  }

  if (pending.type === 'event') {
    const [first, ...rest] = text.split(/\s+/);
    const date = parseBirthday(first ?? '');
    if (!date) {
      await ctx.reply('Не разобрал дату. Формат: <code>12.04 День рождения</code>', { parse_mode: 'HTML' });
      return;
    }
    const title = rest.join(' ') || 'Событие';
    const recurring = date.startsWith('1900') || !/\d{4}-/.test(first ?? '');
    agenda.addEvent(id, /рожд/i.test(title) ? 'birthday' : 'custom', date, { title, recurring });
    await ctx.reply('Дата записана.');
  }

  const card = ui.personCard(id);
  if (card) await ctx.reply(card.text, { parse_mode: 'HTML', reply_markup: card.keyboard });
}
