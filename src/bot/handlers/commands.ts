import { Composer, InlineKeyboard } from 'grammy';
import { config } from '../../config.js';
import { CIRCLES } from '../../domain/circles.js';
import { humanDate, plural, today } from '../../domain/dates.js';
import { parsePerson } from '../../domain/parse.js';
import * as signals from '../../domain/signals.js';
import * as intake from '../../domain/intake.js';
import * as settings from '../../db/repo/settings.js';
import * as timeline from '../../db/repo/timeline.js';
import * as people from '../../db/repo/people.js';
import * as agenda from '../../db/repo/agenda.js';
import * as ui from '../ui.js';
import { getCurrent, setCurrent, takePending } from '../state.js';

export const commands = new Composer();

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const dateLabel = (): string => {
  const d = new Date();
  const w = WEEKDAYS[d.getDay()]!;
  return w[0]!.toUpperCase() + w.slice(1) + ', ' + humanDate(today());
};

/** Строчка о разметке в хвосте дайджеста. Исчезает, когда база набрана. */
export function intakeTail(): string | undefined {
  const st = intake.state();
  if (intake.done(st)) return undefined;
  const left = Math.max(0, st.quota - st.addedToday);
  return left > 0
    ? `<i>Разметка: ${st.total} из ${st.target}. Сегодня осталось добавить ${left}. Откуда доставать — /roster</i>`
    : `<i>Разметка: ${st.total} из ${st.target}. Норма на сегодня закрыта.</i>`;
}

commands.command(['start', 'help'], async (ctx) => {
  await ctx.reply(
    [
      '<b>Круг</b> — личная CRM по знакомым.',
      '',
      '<b>Каждый день</b>',
      '/today — кому написать сегодня',
      '',
      '<b>Добавить человека</b>',
      '<code>/add Аня Соколова #бег круг:2 др:12.04 был:02.07 город:Москва "познакомились на забеге"</code>',
      'Ключи: круг, др, был, тг, тел, город. Теги через #.',
      '<b>был:</b> — когда последний раз общались. Без неё человек не попадёт в напоминания.',
      '',
      '<b>Найти</b>',
      'Просто напиши текст — ищу по имени, городу, тегам, досье и заметкам.',
      '/find юрист',
      '',
      '<b>Досье открытого человека</b>',
      '<code>/f семья Дочь Мира, 5 лет</code>',
      'Блоки: семья, работа, увлечения, планы, зацепки, нетрогать, подарки.',
      '',
      '/stats — заполненность кругов',
      '',
      '<b>Пока набираешь базу</b>',
      '/roster — прогресс и подсказка, кого вспоминать сегодня',
      '/next — следующая подсказка',
      '/gaps — у кого нет даты последнего общения',
      '/target 200, /quota 5 — цель и дневная норма',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
});

commands.command('app', async (ctx) => {
  if (!config.publicUrl.startsWith('https://')) {
    await ctx.reply('Мини-апп не настроен: нужен домен с HTTPS в PUBLIC_URL. Инструкция в README.');
    return;
  }
  await ctx.reply('Карта кругов:', {
    reply_markup: new InlineKeyboard().webApp('Открыть', config.publicUrl),
  });
});

commands.command('today', async (ctx) => {
  const all = signals.collect();
  const { text, keyboard } = ui.digest(
    signals.due(all), signals.horizon(all), dateLabel(), intakeTail(),
  );
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

commands.command('add', async (ctx) => {
  const raw = ctx.match.toString().trim();
  if (!raw) {
    await ctx.reply('Формат: <code>/add Имя Фамилия #тег круг:2 др:12.04</code>', { parse_mode: 'HTML' });
    return;
  }
  const parsed = parsePerson(raw);
  if (!parsed) { await ctx.reply('Не разобрал имя. Первым идёт имя, потом ключи.'); return; }

  const id = people.create({
    name: parsed.name,
    circle: parsed.circle ?? 3,
    city: parsed.city ?? null,
    telegram: parsed.telegram ?? null,
    phone: parsed.phone ?? null,
    met_on: today(),
    met_context: parsed.context ?? null,
    tags: parsed.tags,
  });
  if (parsed.birthday) agenda.addEvent(id, 'birthday', parsed.birthday, { recurring: true });
  if (parsed.lastContact) {
    timeline.logInteraction(id, 'message', { on: parsed.lastContact, summary: 'первичная разметка' });
  }

  setCurrent(id);
  const card = ui.personCard(id)!;
  const st = intake.state();
  const tail = intake.done(st) ? '' :
    `\n\n<i>Разметка: ${st.addedToday} из ${st.quota} за сегодня · всего ${st.total} из ${st.target}</i>` +
    (parsed.lastContact ? '' : '\n<i>Дата последнего общения не указана — добавь ключ <code>был:12.06</code>, иначе человек не попадёт в напоминания.</i>');

  await ctx.reply(card.text + tail, { parse_mode: 'HTML', reply_markup: card.keyboard });
});

// Ритуал разметки: прогресс и подсказка, откуда доставать следующих людей.
commands.command('roster', async (ctx) => {
  const st = intake.state();
  const left = Math.max(0, st.target - st.total);
  const daysLeft = st.quota > 0 ? Math.ceil(left / st.quota) : 0;
  const filled = Math.round((st.total / Math.max(st.target, 1)) * 20);
  const bar = '█'.repeat(Math.min(filled, 20)) + '░'.repeat(Math.max(0, 20 - filled));

  const lines = [
    '<b>Разметка базы</b>',
    `<code>${bar}</code> ${st.total} из ${st.target}`,
    '',
    `Сегодня добавлено: ${st.addedToday} из ${st.quota}`,
  ];
  if (left > 0) lines.push(`Осталось ${left} ${plural(left, 'человек', 'человека', 'человек')} — это примерно ${daysLeft} ${plural(daysLeft, 'день', 'дня', 'дней')}.`);
  else lines.push('Цель взята. Можно поднять планку: /target 300');

  if (st.withoutContact > 0) {
    lines.push('', `<b>Без даты последнего общения: ${st.withoutContact}</b>`,
      '<i>Такие люди не попадают в напоминания вообще. Открой карточку и нажми «Написал», либо укажи дату при добавлении.</i>');
  }

  lines.push('', '<b>Откуда доставать сегодня</b>', st.prompt, '', '<i>Дальше — /next</i>');

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

commands.command('next', async (ctx) => {
  await ctx.reply('<b>Откуда доставать</b>\n' + intake.nextPrompt(), { parse_mode: 'HTML' });
});

commands.command('target', async (ctx) => {
  const n = Number(ctx.match.toString().trim());
  if (!Number.isFinite(n) || n <= 0) {
    await ctx.reply('Формат: <code>/target 200</code>', { parse_mode: 'HTML' });
    return;
  }
  settings.set('intake_target', Math.round(n));
  await ctx.reply(`Цель: ${Math.round(n)} человек.`);
});

commands.command('quota', async (ctx) => {
  const n = Number(ctx.match.toString().trim());
  if (!Number.isFinite(n) || n <= 0) {
    await ctx.reply('Формат: <code>/quota 5</code>', { parse_mode: 'HTML' });
    return;
  }
  settings.set('intake_quota', Math.round(n));
  await ctx.reply(`Норма: ${Math.round(n)} человек в день.`);
});

// Люди без зафиксированной даты общения — главный пробел на этапе разметки.
commands.command('gaps', async (ctx) => {
  const list = people.withoutContact(12);
  if (!list.length) { await ctx.reply('Пробелов нет: у всех есть дата последнего общения.'); return; }
  const { text, keyboard } = ui.searchResults(list);
  await ctx.reply(
    `У этих людей нет даты последнего общения, поэтому они молчат в напоминаниях.\n${text}`,
    { parse_mode: 'HTML', reply_markup: keyboard },
  );
});

commands.command('find', async (ctx) => {
  const q = ctx.match.toString().trim();
  if (!q) { await ctx.reply('Что ищем? <code>/find бишкек</code>', { parse_mode: 'HTML' }); return; }
  const { text, keyboard } = ui.searchResults(people.search(q));
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

commands.command('stats', async (ctx) => {
  const load = signals.circleLoad();
  const all = signals.collect();
  const overdue = all.filter((s) => s.kind === 'late' || s.kind === 'risk').length;

  const lines = ['<b>Круги</b>'];
  for (const c of load) {
    const over = c.n > c.cap ? `  ⚠️ перебор на ${c.n - c.cap}` : '';
    lines.push(`${c.circle} · ${c.label}: ${c.n} / ${c.cap}${over}`);
  }
  lines.push('', `Всего активных: ${load.reduce((s, c) => s + c.n, 0)}`);
  lines.push(`В просрочке: ${overdue}`);
  lines.push('', '<i>Ёмкость — ориентир из слоёв Данбара. Перебор в ядре означает, что внимания на всех не хватит.</i>');

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

// Заполнение досье открытого человека: /f семья Дочь Мира, 5 лет
const FIELD_ALIASES: Record<string, string> = {
  'семья': 'family', 'работа': 'occupation', 'увлечения': 'recreation', 'планы': 'dreams',
  'зацепки': 'hooks', 'нетрогать': 'avoid', 'подарки': 'gift_ideas',
};

commands.command('f', async (ctx) => {
  const id = getCurrent();
  if (!id) { await ctx.reply('Сначала открой карточку человека — найди его поиском.'); return; }

  const raw = ctx.match.toString().trim();
  const [key, ...rest] = raw.split(/\s+/);
  const field = FIELD_ALIASES[(key ?? '').toLowerCase()];
  const text = rest.join(' ').trim();

  if (!field || !text) {
    await ctx.reply('Формат: <code>/f семья Дочь Мира, 5 лет</code>\nБлоки: ' +
      Object.keys(FIELD_ALIASES).join(', '), { parse_mode: 'HTML' });
    return;
  }
  if (!people.isDossierField(field)) return;

  people.appendDossier(id, field, text);
  const card = ui.personCard(id)!;
  await ctx.reply(card.text, { parse_mode: 'HTML', reply_markup: card.keyboard });
});

commands.command('circles', async (ctx) => {
  const lines = ['<b>Слои</b>'];
  for (const [n, c] of Object.entries(CIRCLES)) {
    lines.push(`${n} · ${c.label} — до ${c.cap} человек, интервал ${c.interval} дн`);
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

// Свободный текст: либо ответ на ожидаемый ввод, либо поиск.
commands.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();

  const pending = takePending();
  if (pending) {
    const { handlePendingInput } = await import('./callbacks.js');
    await handlePendingInput(ctx, pending, text);
    return;
  }

  const found = people.search(text);
  if (found.length === 1) {
    setCurrent(found[0]!.id);
    const card = ui.personCard(found[0]!.id)!;
    await ctx.reply(card.text, { parse_mode: 'HTML', reply_markup: card.keyboard });
    return;
  }
  const { text: t, keyboard } = ui.searchResults(found);
  await ctx.reply(t, { parse_mode: 'HTML', reply_markup: keyboard as InlineKeyboard });
});
