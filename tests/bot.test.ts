/**
 * Тесты обработчиков бота: обновления скармливаются через bot.handleUpdate,
 * вызовы Telegram API перехватываются трансформером — сеть не нужна.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['BOT_TOKEN'] ??= 'test-token';
process.env['OWNER_ID'] ??= '1';
process.env['DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'crm-bot-')), 'test.db');

const { bot } = await import('../src/bot/index.js');
const people = await import('../src/db/repo/people.js');
const timeline = await import('../src/db/repo/timeline.js');
const agenda = await import('../src/db/repo/agenda.js');
const { getPending } = await import('../src/bot/state.js');
const { db } = await import('../src/db/index.js');
const { addDays, today } = await import('../src/domain/dates.js');

// --- заглушка Telegram API: копим исходящие вызовы, отвечаем правдоподобно
const sent: { method: string; payload: Record<string, unknown> }[] = [];
bot.botInfo = {
  id: 42, is_bot: true as const, first_name: 'test', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
};
bot.api.config.use(async (_prev, method, payload) => {
  sent.push({ method, payload: payload as Record<string, unknown> });
  const result = method === 'sendMessage'
    ? { message_id: sent.length, date: 0, chat: { id: 1, type: 'private' }, text: 'ok' }
    : true;
  return { ok: true, result } as never;
});

const FROM = { id: 1, is_bot: false, first_name: 'Владелец' };
const CHAT = { id: 1, type: 'private' as const };
let updateId = 0;

async function sendText(text: string): Promise<void> {
  const entities = text.startsWith('/')
    ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }]
    : [];
  await bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: updateId, date: 0, chat: CHAT, from: FROM, text, entities },
  });
}

async function sendCallback(data: string): Promise<void> {
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(updateId), from: FROM, chat_instance: 'x', data,
      message: { message_id: updateId, date: 0, chat: CHAT, from: bot.botInfo, text: 'stub' },
    },
  });
}

const lastReply = (): string => String(sent.filter((s) => s.method === 'sendMessage').at(-1)?.payload['text'] ?? '');

test('/add разбирает ключи и создаёт человека с датой и днём рождения', async () => {
  await sendText('/add Костя Лапшин #бег круг:2 др:12.04 был:02.07 город:Москва "познакомились на забеге"');

  const found = people.search('Костя Лапшин');
  assert.equal(found.length, 1);
  const p = found[0]!;
  assert.equal(p.circle, 2);
  assert.equal(p.city, 'Москва');
  assert.ok(timeline.lastInteraction(p.id), 'ключ был: создал контакт');
  assert.ok(agenda.eventsOf(p.id).some((e) => e.kind === 'birthday'));
  assert.match(lastReply(), /Костя Лапшин/);
});

test('через:Имя связывает нового человека с коннектором', async () => {
  await sendText('/add Аня Соколова #бег круг:2 через:Костя');
  const anya = people.search('Аня Соколова')[0]!;
  const kostya = people.search('Костя Лапшин')[0]!;
  assert.equal(anya.met_via, kostya.id);
  assert.equal(people.introduced(kostya.id).length, 1);
});

test('колбэк c:id:message пишет контакт и ждёт «о чём говорили»', async () => {
  const p = people.search('Аня Соколова')[0]!;
  const before = timeline.lastInteraction(p.id);
  await sendCallback(`c:${p.id}:message`);

  const after = timeline.lastInteraction(p.id);
  assert.ok(after && after.id !== before?.id, 'контакт записан');
  assert.deepEqual(getPending(), { type: 'contact_note', personId: p.id });

  // следующий свободный текст уходит заметкой
  await sendText('говорили про марафон');
  assert.equal(getPending(), null);
  assert.match(timeline.notesOf(p.id, 1)[0]!.body, /марафон/);
});

test('обещание «до 30.07» получает год, а не теряет срок', async () => {
  const p = people.search('Аня Соколова')[0]!;
  await sendCallback(`t:${p.id}`);
  await sendText('я скинуть контакт врача до 30.07');

  const task = agenda.tasksOf(p.id).at(-1)!;
  assert.ok(task.due_on, 'срок сохранился');
  assert.ok(!task.due_on!.startsWith('1900'), 'год подставлен');
  assert.ok(task.due_on! >= today(), 'срок не в прошлом');
});

test('колбэк ev: закрывает наступление события', async () => {
  const p = people.search('Костя Лапшин')[0]!;
  const soon = addDays(today(), 2);
  const evId = agenda.addEvent(p.id, 'custom', soon, { title: 'Защита', recurring: false });

  await sendCallback(`ev:${evId}:${soon}`);
  const row = db.prepare('SELECT handled_for FROM event WHERE id = ?').get(evId) as { handled_for: string };
  assert.equal(row.handled_for, soon);
});

test('чужой пользователь молча игнорируется', async () => {
  const countBefore = sent.length;
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId, date: 0, chat: { id: 999, type: 'private' },
      from: { id: 999, is_bot: false, first_name: 'Чужой' }, text: '/today',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  });
  assert.equal(sent.filter((s, i) => i >= countBefore && s.method === 'sendMessage').length, 0);
});
