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
