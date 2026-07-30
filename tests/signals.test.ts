/**
 * Тесты ядра — сбора сигналов. Запуск: npm test.
 *
 * env выставляется до динамических импортов: config.ts падает без BOT_TOKEN,
 * а db/index.ts применяет миграции прямо при импорте.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['BOT_TOKEN'] ??= 'test-token';
process.env['OWNER_ID'] ??= '1';
process.env['DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'crm-signals-')), 'test.db');

const people = await import('../src/db/repo/people.js');
const timeline = await import('../src/db/repo/timeline.js');
const agenda = await import('../src/db/repo/agenda.js');
const settings = await import('../src/db/repo/settings.js');
const family = await import('../src/domain/family.js');
const signals = await import('../src/domain/signals.js');
const { addDays } = await import('../src/domain/dates.js');

/** Фиксированное «сегодня»: тесты не зависят от реальной даты запуска. */
const NOW = '2026-07-30';

/** Ежегодная дата с годом-заглушкой 1900, отстоящая от NOW на offset дней. */
const yearly = (offset: number): string => '1900' + addDays(NOW, offset).slice(4);

const of = (list: ReturnType<typeof signals.collect>, personId: number) =>
  list.filter((s) => s.person.id === personId);

test('человек без единого контакта не попадает в сигналы тишины', () => {
  const id = people.create({ name: 'Тихий Новичок', circle: 0 });
  assert.equal(of(signals.collect(NOW), id).length, 0);
});

test('тишина: late при ratio ≥ 1, risk при ratio ≥ 2.5', () => {
  const late = people.create({ name: 'Слегка Забытый', circle: 0 }); // интервал 14
  timeline.logInteraction(late, 'message', { on: addDays(NOW, -15) });
  const risk = people.create({ name: 'Совсем Забытый', circle: 0 });
  timeline.logInteraction(risk, 'message', { on: addDays(NOW, -40) });

  const all = signals.collect(NOW);
  assert.equal(of(all, late)[0]?.kind, 'late');
  assert.equal(of(all, risk)[0]?.kind, 'risk');
});

test('событие в пределах lead_days даёт сигнал, за пределами — нет', () => {
  const soon = people.create({ name: 'Скоро Именинник', circle: 2 });
  agenda.addEvent(soon, 'birthday', yearly(10), { recurring: true });
  const far = people.create({ name: 'Нескоро Именинник', circle: 2 });
  agenda.addEvent(far, 'birthday', yearly(40), { recurring: true });

  const all = signals.collect(NOW);
  const s = of(all, soon)[0];
  assert.equal(s?.kind, 'event');
  assert.equal(s?.days, 10);
  assert.equal(of(all, far).length, 0);
});

test('handled_for гасит закрытое наступление', () => {
  const id = people.create({ name: 'Уже Поздравлен', circle: 2 });
  const eventId = agenda.addEvent(id, 'birthday', yearly(3), { recurring: true });
  agenda.markEventHandled(eventId, addDays(NOW, 3));
  assert.equal(of(signals.collect(NOW), id).length, 0);
});

test('прошедшее незакрытое событие даёт missed с приоритетом 900', () => {
  const id = people.create({ name: 'Пропущенный Повод', circle: 2 });
  agenda.addEvent(id, 'birthday', yearly(-2), { recurring: true });
  const s = of(signals.collect(NOW), id)[0];
  assert.equal(s?.kind, 'missed');
  assert.equal(s?.priority, 900);
});

test('snooze скрывает все сигналы человека', () => {
  const id = people.create({ name: 'Отложенный Насовсем', circle: 0 });
  timeline.logInteraction(id, 'message', { on: addDays(NOW, -40) });
  agenda.addEvent(id, 'birthday', yearly(2), { recurring: true });
  timeline.snooze(id, addDays(NOW, 7));
  assert.equal(of(signals.collect(NOW), id).length, 0);
});

test('обещания: близкий срок и просрочка сигналят, далёкий — нет', () => {
  const id = people.create({ name: 'Должник Обещаний', circle: 2 });
  agenda.addTask(id, 'i_owe', 'скинуть контакт', addDays(NOW, 2));
  agenda.addTask(id, 'they_owe', 'вернуть книгу', addDays(NOW, -5));
  agenda.addTask(id, 'i_owe', 'позвать на обед', addDays(NOW, 10));

  const owed = of(signals.collect(NOW), id).filter((s) => s.kind === 'owed');
  assert.equal(owed.length, 2);
  const overdue = owed.find((s) => s.why.includes('вернуть книгу'));
  assert.equal(overdue?.priority, 805);
});

// Регрессия: день рождения родственника висит на карточке-заглушке,
// которой нет в people.active(). Раньше такое событие молча отбрасывалось.
test('день рождения родственника-заглушки сигналит владельцу', () => {
  const dad = people.create({ name: 'Папа Регрессии', circle: 1 });
  const kid = family.addMember(dad, { name: 'Лёва', role: 'child' });
  agenda.addEvent(kid, 'birthday', yearly(2), { recurring: true });

  const s = of(signals.collect(NOW), dad)[0];
  assert.equal(s?.kind, 'event');
  assert.ok(s?.why.includes('ребёнок Лёва'), `формулировка: ${s?.why}`);
});

test('пропущенный день рождения заглушки тоже сигналит владельцу', () => {
  const mom = people.create({ name: 'Мама Регрессии', circle: 1 });
  const kid = family.addMember(mom, { name: 'Мира', role: 'child' });
  agenda.addEvent(kid, 'birthday', yearly(-1), { recurring: true });

  const s = of(signals.collect(NOW), mom)[0];
  assert.equal(s?.kind, 'missed');
  assert.ok(s?.why.includes('Мира'));
});

test('производная связь: ребёнок сигналит и супругу родителя', () => {
  const dad = people.create({ name: 'Отец Производный', circle: 1 });
  const mom = people.create({ name: 'Мачеха Производная', circle: 1 });
  const kid = family.addMember(dad, { name: 'Тёма', role: 'child' });
  family.link(dad, mom, 'spouse');
  family.rebuildDerived(dad);
  agenda.addEvent(kid, 'birthday', yearly(4), { recurring: true });

  const all = signals.collect(NOW);
  assert.equal(of(all, dad)[0]?.kind, 'event');
  assert.equal(of(all, mom)[0]?.kind, 'event');
});

test('заглушка без события по-прежнему не порождает ни тишины, ни пробелов', () => {
  const owner = people.create({ name: 'Хозяин Тихой Заглушки', circle: 2 });
  const stub = family.addMember(owner, { name: 'Молчаливый Дед', role: 'relative' });
  assert.equal(of(signals.collect(NOW), stub).length, 0);
});

// lead_days меняет базу целиком — тест в конце, чтобы не влиять на остальные.
test('lead_days: default берётся из настроек, массовое обновление работает', () => {
  settings.set(agenda.LEAD_DAYS_KEY, 21);
  const id = people.create({ name: 'Настройка Горизонта', circle: 2 });
  const eventId = agenda.addEvent(id, 'custom', addDays(NOW, 60), { recurring: false });
  const created = agenda.eventsOf(id).find((e) => e.id === eventId);
  assert.equal(created?.lead_days, 21);

  agenda.setAllLeadDays(9);
  const updated = agenda.eventsOf(id).find((e) => e.id === eventId);
  assert.equal(updated?.lead_days, 9);

  settings.set(agenda.LEAD_DAYS_KEY, agenda.LEAD_DAYS_DEFAULT);
});
