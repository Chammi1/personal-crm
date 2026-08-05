import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { CIRCLES, intervalFor } from '../../domain/circles.js';
import { addDays, daysBetween, humanDate, humanDays, nextOccurrence, plural, today } from '../../domain/dates.js';
import { parseVoiceNote } from '../voice.js';
import { parseBirthday, parsePerson } from '../../domain/parse.js';
import * as signals from '../../domain/signals.js';
import * as intake from '../../domain/intake.js';
import * as settings from '../../db/repo/settings.js';
import * as timeline from '../../db/repo/timeline.js';
import * as people from '../../db/repo/people.js';
import * as agenda from '../../db/repo/agenda.js';
import * as collective from '../../db/repo/collective.js';
import * as family from '../../domain/family.js';
import * as network from '../../domain/network.js';
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
      '/lead — за сколько дней напоминать о датах',
      '/brief Аня — шпаргалка перед разговором',
      '/cevent 15.08 Забег #бег — коллективное событие на весь кластер',
      '/export — вся база в CSV, /backup — файл базы в чат',
      'Голосовое сообщение — расшифруется и уйдёт заметкой к открытой карточке (нужен OPENAI_API_KEY).',
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

  // через:Тимур — кто представил; ищем по базе, при неоднозначности пропускаем
  let metVia: number | null = null;
  let viaNote = '';
  if (parsed.viaName) {
    const via = people.search(parsed.viaName, 2);
    if (via.length === 1) { metVia = via[0]!.id; viaNote = `\nПредставил: ${via[0]!.name}`; }
    else viaNote = `\n<i>«через:${parsed.viaName}» — ${via.length ? 'несколько совпадений' : 'не нашёл'}, связь не записана.</i>`;
  }

  const id = people.create({
    name: parsed.name,
    circle: parsed.circle ?? 3,
    city: parsed.city ?? null,
    telegram: parsed.telegram ?? null,
    phone: parsed.phone ?? null,
    met_on: today(),
    met_context: parsed.context ?? null,
    met_via: metVia,
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

  await ctx.reply(card.text + viaNote + tail, { parse_mode: 'HTML', reply_markup: card.keyboard });
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

// Горизонт поводов: за сколько дней даты начинают проявляться в дайджесте и на карте.
commands.command('lead', async (ctx) => {
  const raw = ctx.match.toString().trim();
  if (!raw) {
    await ctx.reply(
      `Поводы проявляются за ${agenda.leadDaysDefault()} дн до даты.\n` +
      'Изменить: <code>/lead 21</code> — применится и к новым, и к уже заведённым датам.',
      { parse_mode: 'HTML' },
    );
    return;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 90) {
    await ctx.reply('Формат: <code>/lead 21</code> — целое число дней от 1 до 90.', { parse_mode: 'HTML' });
    return;
  }
  settings.set(agenda.LEAD_DAYS_KEY, n);
  agenda.setAllLeadDays(n);
  await ctx.reply(`Теперь поводы проявляются за ${n} дн — у новых и существующих дат.`);
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

/**
 * Аналитика сети: здоровье кластеров, мосты между ними, коннекторы, дыры.
 * Без теории графов — честные агрегаты, на которые можно опереться действием.
 */
commands.command('network', async (ctx) => {
  if (!people.active().length) { await ctx.reply('Сеть пуста — начни с /add.'); return; }
  const view = network.analyze();
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = ['<b>Сеть изнутри</b>', '', '<b>Кластеры</b>'];
  for (const c of view.clusters.slice(0, 8)) {
    lines.push(`#${esc(c.tag)} — ${c.n} чел${c.avgSilence !== null ? `, тишина в среднем ${c.avgSilence} дн` : ', контакты не размечены'}`);
  }

  if (view.bridges.length) {
    lines.push('', '<b>Мосты между кластерами</b>');
    for (const b of view.bridges.slice(0, 5)) {
      lines.push(`${esc(b.name)} — ${b.tags.map((t) => '#' + esc(t)).join(' ')}`);
    }
    lines.push('<i>Потеряешь моста — потеряешь связь с целым куском сети.</i>');
  }

  if (view.connectors.length) {
    lines.push('', '<b>Коннекторы</b>');
    for (const c of view.connectors.slice(0, 5)) {
      lines.push(`${esc(c.name)} — привёл ${c.n} ${plural(c.n, 'человека', 'человек', 'человек')}`);
    }
  } else {
    lines.push('', '<i>Коннекторы не размечены: добавляй людей с ключом <code>через:Тимур</code> — узнаешь, кто расширяет твою сеть.</i>');
  }

  if (view.holes.length) {
    lines.push('', '<b>Заброшенные кластеры</b>');
    for (const h of view.holes.slice(0, 4)) {
      lines.push(`#${esc(h.tag)} — ${h.freshest === null ? 'ни одного размеченного контакта' : `тишина минимум ${h.freshest} дн у всех ${h.n}`}`);
    }
    lines.push('<i>Один контакт с мостом из такого кластера оживляет весь кластер.</i>');
  }

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

// Коллективные события: /cevent 15.08 Полумарафон #бег — повод на весь кластер.
commands.command('cevent', async (ctx) => {
  const raw = ctx.match.toString().trim();

  if (!raw) {
    const list = collective.all();
    if (!list.length) {
      await ctx.reply(
        'Коллективных событий нет.\nДобавить: <code>/cevent 15.08 Полумарафон #бег</code>\n' +
        'Без тега — повод для всей сети. Без года — ежегодное.',
        { parse_mode: 'HTML' },
      );
      return;
    }
    const kb = new InlineKeyboard();
    const lines = ['<b>Коллективные события</b>'];
    for (const ce of list) {
      const next = nextOccurrence(ce.event_date, ce.recurring === 1, today());
      lines.push(`${ce.title} — ${humanDate(next)}${ce.tag ? ` · #${ce.tag}` : ' · вся сеть'}`);
      kb.text(`✕ ${ce.title.slice(0, 20)}`, `cevdel:${ce.id}`).row();
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
    return;
  }

  const parts = raw.split(/\s+/);
  const date = parseBirthday(parts[0] ?? '');
  if (!date) {
    await ctx.reply('Первым — дата: <code>/cevent 15.08 Полумарафон #бег</code>', { parse_mode: 'HTML' });
    return;
  }
  let tag: string | null = null;
  const words: string[] = [];
  for (const w of parts.slice(1)) {
    if (w.startsWith('#')) tag = w.slice(1).toLowerCase();
    else words.push(w);
  }
  const title = words.join(' ') || 'Событие';
  const recurring = date.startsWith('1900');
  const audience = tag ? people.withTag(tag).length : people.active().length;

  collective.add(title, date, { tag, recurring });
  await ctx.reply(
    `Записано: <b>${title}</b> — ${humanDate(nextOccurrence(date, recurring, today()))}` +
    `${tag ? ` · #${tag}` : ' · вся сеть'} (${audience} чел).\n` +
    `${recurring ? 'Ежегодное.' : 'Разовое.'} Список и удаление: /cevent`,
    { parse_mode: 'HTML' },
  );
});

// Брифинг перед разговором: всё важное о человеке одним сообщением.
commands.command('brief', async (ctx) => {
  const q = ctx.match.toString().trim();
  let id = getCurrent();
  if (q) {
    const found = people.search(q, 2);
    if (!found.length) { await ctx.reply('Не нашёл такого человека.'); return; }
    if (found.length > 1) {
      const { text, keyboard } = ui.searchResults(found);
      await ctx.reply('Уточни, кто именно:\n' + text, { parse_mode: 'HTML', reply_markup: keyboard });
      return;
    }
    id = found[0]!.id;
  }
  if (!id) {
    await ctx.reply('Кого брифуем? <code>/brief Аня</code> — или сначала открой карточку.', { parse_mode: 'HTML' });
    return;
  }

  const p = people.byId(id);
  if (!p) { await ctx.reply('Человек не найден.'); return; }
  setCurrent(id);

  const now = today();
  const d = people.dossierOf(id);
  const last = timeline.lastInteraction(id);
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = [`<b>Перед разговором: ${esc(p.name)}</b>`];
  const head = [CIRCLES[p.circle].label];
  if (p.city) head.push(esc(p.city));
  if (d?.occupation) head.push(esc(d.occupation));
  lines.push(`<i>${head.join(' · ')}</i>`, '');

  if (last) {
    const silent = daysBetween(last.happened_on, now);
    lines.push(`Последний контакт — ${humanDate(last.happened_on)} (${silent} дн назад, норма ${intervalFor(p.circle, p.target_interval)}).`);
    if (last.summary && last.summary !== 'первичная разметка') lines.push(`Тогда: ${esc(last.summary)}`);
  }

  const notes = timeline.notesOf(id, 2);
  for (const n of notes) lines.push(`Заметка ${humanDate(n.written_on)}: ${esc(n.body)}`);

  const tasks = agenda.tasksOf(id);
  for (const t of tasks) {
    lines.push(`${t.direction === 'i_owe' ? '❗ Ты обещал' : 'Тебе обещали'}: ${esc(t.body)}${t.due_on ? ' — до ' + humanDate(t.due_on) + (t.due_auto ? ' (авто)' : '') : ''}`);
  }

  const upcoming = agenda.eventsOf(id)
    .map((e) => {
      const next = nextOccurrence(e.event_date, e.recurring === 1, now);
      return { title: e.title ?? 'День рождения', days: daysBetween(now, next) };
    })
    .filter((e) => e.days >= 0 && e.days <= 45)
    .sort((a, b) => a.days - b.days);
  for (const e of upcoming) lines.push(`📅 ${esc(e.title)} — ${humanDays(e.days)}`);

  const kin = family.familyOf(id);
  if (kin.length) lines.push(`Семья: ${kin.map((m) => `${esc(m.name)} (${m.label})`).join(', ')}`);

  if (d?.hooks) lines.push('', `🎣 О чём поговорить: ${esc(d.hooks)}`);
  if (d?.dreams) lines.push(`⭐ Его цели: ${esc(d.dreams)}`);
  if (d?.avoid) lines.push(`⛔ Не трогать: ${esc(d.avoid)}`);

  if (lines.length <= 3) lines.push('Досье пустое — после разговора запиши хоть одну зацепку: /f зацепки …');

  const kb = new InlineKeyboard()
    .text('Написал', `c:${id}:message`).text('Позвонил', `c:${id}:call`).text('Встретились', `c:${id}:meeting`)
    .row().text('Открыть карточку', `p:${id}`);

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
});

// Экспорт всей базы в CSV: данные о людях не должны быть заперты в системе.
commands.command('export', async (ctx) => {
  const q = (s: string | null | undefined): string => `"${(s ?? '').replace(/"/g, '""')}"`;
  const header = 'name,circle,city,telegram,phone,email,tags,birthday,last_contact,context,family,occupation,recreation,dreams,hooks,avoid,gift_ideas,rapport';
  const lastMap = timeline.lastContactMap();
  const rows = [header];

  for (const p of people.active()) {
    const d = people.dossierOf(p.id);
    const bd = agenda.eventsOf(p.id).find((e) => e.kind === 'birthday');
    rows.push([
      q(p.name), p.circle, q(p.city), q(p.telegram), q(p.phone), q(p.email),
      q(people.tagsOf(p.id).join(';')),
      q(bd ? (bd.event_date.startsWith('1900') ? bd.event_date.slice(5).split('-').reverse().join('.') : bd.event_date) : ''),
      q(lastMap.get(p.id) ?? ''), q(p.met_context),
      q(d?.family), q(d?.occupation), q(d?.recreation), q(d?.dreams),
      q(d?.hooks), q(d?.avoid), q(d?.gift_ideas),
      p.rapport ?? '',
    ].join(','));
  }

  // ﻿ — BOM, чтобы Excel открыл кириллицу без танцев с кодировкой
  const file = new InputFile(Buffer.from('﻿' + rows.join('\n'), 'utf8'), `krug-export-${today()}.csv`);
  await ctx.replyWithDocument(file, {
    caption: `${rows.length - 1} человек. Колонки совместимы с импортом (npm run import).`,
  });
});

// Бэкап: файл базы прямо в этот чат. Telegram — не третье облако, а тот же
// канал, по которому уже ходят все эти данные.
commands.command('backup', async (ctx) => {
  const dest = join(tmpdir(), `crm-backup-${today()}.db`);
  await db.backup(dest);
  await ctx.replyWithDocument(new InputFile(dest), {
    caption: `Бэкап базы, ${today()}. Восстановление: положить файл как data/crm.db и перезапустить.`,
  });
  unlinkSync(dest);
});

commands.command('circles', async (ctx) => {
  const lines = ['<b>Слои</b>'];
  for (const [n, c] of Object.entries(CIRCLES)) {
    lines.push(`${n} · ${c.label} — до ${c.cap} человек, интервал ${c.interval} дн`);
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

/**
 * Голосовые: расшифровка через Whisper и дальше как обычный текст —
 * ответ на ожидаемый ввод (заметка, обещание) или заметка к открытой карточке.
 * Без OPENAI_API_KEY функция честно выключена.
 */
commands.on('message:voice', async (ctx) => {
  if (!config.openaiKey) {
    await ctx.reply(
      'Расшифровка голосовых выключена: добавь <code>OPENAI_API_KEY</code> в .env и перезапусти.',
      { parse_mode: 'HTML' },
    );
    return;
  }
  if ((ctx.message.voice.duration ?? 0) > 300) {
    await ctx.reply('Слишком длинное — до 5 минут.');
    return;
  }

  try {
    const f = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${config.botToken}/${f.file_path}`;
    const audio = await (await fetch(url)).arrayBuffer();

    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'voice.ogg');
    form.append('model', 'whisper-1');
    form.append('language', 'ru');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openaiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = ((await res.json() as { text?: string }).text ?? '').trim();
    if (!text) { await ctx.reply('Не расслышал — попробуй ещё раз.'); return; }

    const pending = takePending();
    if (pending) {
      const { handlePendingInput } = await import('./callbacks.js');
      await ctx.reply(`🎙 «${text}»`);
      await handlePendingInput(ctx, pending, text);
      return;
    }

    // Умный разбор: LLM раскладывает заметку в контакт / досье / обещание.
    // Ошибка разбора не роняет сценарий — тогда всё уходит одной заметкой.
    const parsed = await parseVoiceNote(text);

    let targetId = getCurrent();
    let matchedBy = '';
    if (parsed?.name) {
      const found = people.search(parsed.name, 2);
      if (found.length === 1) { targetId = found[0]!.id; matchedBy = ` (узнал: ${found[0]!.name})`; }
    }
    if (!targetId) {
      await ctx.reply(`🎙 «${text}»\n\nНе понял, о ком речь. Открой карточку или назови имя в самом голосовом.`);
      return;
    }

    const done: string[] = [];
    if (parsed?.contact) {
      timeline.logInteraction(targetId, parsed.contact, { summary: parsed.note ?? undefined });
      done.push({ message: 'переписка', call: 'звонок', meeting: 'встреча' }[parsed.contact]);
    }
    if (parsed) {
      for (const [field, value] of Object.entries(parsed.dossier)) {
        if (people.isDossierField(field) && typeof value === 'string' && value.trim()) {
          people.appendDossier(targetId, field, value.trim());
          done.push(`досье: ${field}`);
        }
      }
      if (parsed.task) {
        const due = parsed.task.dueDays !== null ? addDays(today(), parsed.task.dueDays) : null;
        agenda.addTask(targetId, parsed.task.direction, parsed.task.body, due);
        done.push('обещание');
      }
    }
    if (!parsed?.contact) {
      // без контакта заметка сохраняется отдельно; при контакте суть уже в summary
      timeline.addNote(targetId, parsed?.note ?? text, 'voice');
      done.push('заметка');
    }

    setCurrent(targetId);
    const p = people.byId(targetId);
    await ctx.reply(
      `🎙 «${text}»\n\n${p?.name ?? '?'}${matchedBy}: записано — ${done.join(', ')}.`,
    );
    const card = ui.personCard(targetId);
    if (card) await ctx.reply(card.text, { parse_mode: 'HTML', reply_markup: card.keyboard });
  } catch (err) {
    console.error('[voice]', err);
    await ctx.reply('Не получилось расшифровать: ' + (err instanceof Error ? err.message : 'ошибка'));
  }
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
