/**
 * Тесты HTTP-обработчиков мини-аппа: раньше API проверялся только руками.
 * env выставляется до динамических импортов — config.ts требует BOT_TOKEN,
 * а db/index.ts применяет миграции при импорте.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['BOT_TOKEN'] ??= 'test-token';
process.env['OWNER_ID'] ??= '1';
process.env['DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'crm-api-')), 'test.db');

const { api } = await import('../src/server/api.js');
const agenda = await import('../src/db/repo/agenda.js');
const collective = await import('../src/db/repo/collective.js');
const people = await import('../src/db/repo/people.js');
const signals = await import('../src/domain/signals.js');
const { addDays, today } = await import('../src/domain/dates.js');

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('POST /person принимает расширенную форму: досье и оценка сохраняются', async () => {
  const res = await api.request('/person', json({
    name: 'Аня Тестова', circle: 2, tags: ['бег'], city: 'Москва',
    occupation: 'Юрист в IT', hooks: 'марафон', dreams: 'своя практика',
    rapport: 4, lastContact: addDays(today(), -10), birthday: '12.04.1997',
  }));
  assert.equal(res.status, 200);
  const { id } = await res.json() as { id: number };

  const card = await (await api.request('/person/' + id)).json() as {
    dossier: { occupation: string; hooks: string }; rapport: number;
    interactions: unknown[]; family: unknown[];
  };
  assert.equal(card.dossier.occupation, 'Юрист в IT');
  assert.equal(card.dossier.hooks, 'марафон');
  assert.equal(card.rapport, 4);
  assert.ok(Array.isArray(card.interactions) && card.interactions.length === 1);
});

test('GET /people отдаёт справочник с городом, тегами и работой', async () => {
  const res = await api.request('/people');
  assert.equal(res.status, 200);
  const list = await res.json() as { name: string; city: string; tags: string[]; occupation: string | null }[];
  const anya = list.find((p) => p.name === 'Аня Тестова')!;
  assert.equal(anya.city, 'Москва');
  assert.deepEqual(anya.tags, ['бег']);
  assert.equal(anya.occupation, 'Юрист в IT');
});

test('семья в карточке: возраст и дни до ДР считаются', async () => {
  const list = await (await api.request('/people')).json() as { id: number; name: string }[];
  const anyaId = list.find((p) => p.name === 'Аня Тестова')!.id;

  const fam = await api.request(`/person/${anyaId}/family`, json({
    name: 'Мира', role: 'child', birthday: '02.03.2021',
  }));
  assert.equal(fam.status, 200);

  const card = await (await api.request('/person/' + anyaId)).json() as {
    family: { name: string; age: number | null; birthdayDays: number | null }[];
  };
  const mira = card.family.find((m) => m.name === 'Мира')!;
  assert.ok(mira.age !== null && mira.age >= 4);
  assert.ok(mira.birthdayDays !== null && mira.birthdayDays >= 0 && mira.birthdayDays <= 366);
});

test('POST /event/:id/close гасит сигнал события', async () => {
  const id = people.create({ name: 'Именинник Скорый', circle: 1 });
  const soon = addDays(today(), 3);
  const evId = agenda.addEvent(id, 'birthday', '1900' + soon.slice(4), { recurring: true });

  const before = signals.collect().filter((s) => s.person.id === id && s.kind === 'event');
  assert.equal(before.length, 1);

  const res = await api.request(`/event/${evId}/close`, json({ occurrence: soon }));
  assert.equal(res.status, 200);

  const after = signals.collect().filter((s) => s.person.id === id && s.kind === 'event');
  assert.equal(after.length, 0);
});

test('коллективное событие сигналит всем с тегом и закрывается одним махом', async () => {
  const a = people.create({ name: 'Бегун Первый', circle: 2, tags: ['клуб'] });
  const b = people.create({ name: 'Бегун Второй', circle: 3, tags: ['клуб'] });
  const c = people.create({ name: 'Посторонний Человек', circle: 3, tags: ['работа'] });

  const race = addDays(today(), 5);
  const ceId = collective.add('Полумарафон', race, { tag: 'клуб', recurring: false });

  const got = signals.collect().filter((s) => s.collectiveId === ceId);
  const ids = new Set(got.map((s) => s.person.id));
  assert.ok(ids.has(a) && ids.has(b), 'оба человека с тегом получают сигнал');
  assert.ok(!ids.has(c), 'человек без тега сигнала не получает');

  collective.markHandled(ceId, race);
  const after = signals.collect().filter((s) => s.collectiveId === ceId);
  assert.equal(after.length, 0, 'после закрытия повод гаснет у всех');
});

test('битая дата в /person/:id/event отклоняется', async () => {
  const list = await (await api.request('/people')).json() as { id: number }[];
  const res = await api.request(`/person/${list[0]!.id}/event`, json({ date: '31.11', title: 'Ошибка' }));
  assert.equal(res.status, 400);
});

test('быстрый лог: контакт возвращает interactionId, summary дописывается вторым запросом', async () => {
  const id = people.create({ name: 'Собеседник Быстрый', circle: 2 });

  const res = await api.request(`/person/${id}/contact`, json({ channel: 'message' }));
  assert.equal(res.status, 200);
  const { interactionId } = await res.json() as { interactionId: number };
  assert.ok(interactionId > 0, 'id касания вернулся клиенту');

  const sum = await api.request(`/interaction/${interactionId}/summary`, json({ body: 'обсудили запуск' }));
  assert.equal(sum.status, 200);

  const card = await (await api.request('/person/' + id)).json() as {
    interactions: { id: number; summary: string | null }[];
    notes: { body: string }[];
  };
  assert.equal(card.interactions.find((i) => i.id === interactionId)?.summary, 'обсудили запуск');
  assert.ok(card.notes.some((n) => n.body === 'обсудили запуск'), 'копия ушла в заметки');

  const missing = await api.request('/interaction/999999/summary', json({ body: 'мимо' }));
  assert.equal(missing.status, 404);
});

test('обещание без даты получает автосрок +14 дней и помечено «авто»', async () => {
  const id = people.create({ name: 'Обещанник Автоматов', circle: 2 });

  const res = await api.request(`/person/${id}/task`, json({ body: 'скинуть книгу' }));
  assert.equal(res.status, 200);

  const task = agenda.tasksOf(id)[0]!;
  assert.equal(task.due_on, addDays(today(), 14));
  assert.equal(task.due_auto, 1);
});

test('обещание с датой: своя дата сохраняется, «19.08» без года не падает, прошлое отклоняется', async () => {
  const id = people.create({ name: 'Обещанник Ручной', circle: 2 });

  const manual = addDays(today(), 5);
  const ok = await api.request(`/person/${id}/task`, json({ body: 'позвать на обед', due: manual }));
  assert.equal(ok.status, 200);
  const t = agenda.tasksOf(id).find((x) => x.body === 'позвать на обед')!;
  assert.equal(t.due_on, manual);
  assert.equal(t.due_auto, 0);

  // dd.mm без года: подставляется текущий/следующий год, а не 1900
  const dm = await api.request(`/person/${id}/task`, json({ body: 'с годом разберись', due: '19.08' }));
  assert.equal(dm.status, 200);
  const t2 = agenda.tasksOf(id).find((x) => x.body === 'с годом разберись')!;
  assert.ok(t2.due_on! >= today(), 'срок не в прошлом');
  assert.ok(!t2.due_on!.startsWith('1900'));

  const past = await api.request(`/person/${id}/task`, json({ body: 'в прошлое', due: addDays(today(), -3) }));
  assert.equal(past.status, 400);

  const trash = await api.request(`/person/${id}/task`, json({ body: 'кривая дата', due: 'завтра' }));
  assert.equal(trash.status, 400);
});
