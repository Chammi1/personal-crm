import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBirthday, parsePerson } from '../src/domain/parse.js';
import { today } from '../src/domain/dates.js';

test('parseBirthday: валидные даты проходят', () => {
  assert.equal(parseBirthday('12.04'), '1900-04-12');
  assert.equal(parseBirthday('12.04.1991'), '1991-04-12');
  assert.equal(parseBirthday('1991-04-12'), '1991-04-12');
  assert.equal(parseBirthday('1.9'), '1900-09-01');
  // 29 февраля разрешено даже без года — реальный год мог быть високосным
  assert.equal(parseBirthday('29.02'), '1900-02-29');
});

test('parseBirthday: несуществующие даты отклоняются, а не превращаются в NaN-события', () => {
  assert.equal(parseBirthday('31.11'), null);   // в ноябре 30 дней
  assert.equal(parseBirthday('32.01'), null);
  assert.equal(parseBirthday('05.13'), null);   // 13-й месяц
  assert.equal(parseBirthday('00.05'), null);
  assert.equal(parseBirthday('10.00'), null);
  assert.equal(parseBirthday('30.02'), null);
  assert.equal(parseBirthday('2026-13-05'), null);
  assert.equal(parseBirthday('2026-11-31'), null);
});

test('был: без года никогда не даёт дату в будущем', () => {
  const now = today();
  // 31 декабря без года: летом это прошлый год, а не будущий
  const p = parsePerson('Тест Тестов был:31.12');
  assert.ok(p?.lastContact);
  assert.ok(p!.lastContact! <= now, `${p!.lastContact} должно быть не позже ${now}`);

  // вчера-сегодня остаются в текущем году
  const [y, m, d] = now.split('-');
  const p2 = parsePerson(`Тест Тестов был:${Number(d)}.${Number(m)}`);
  assert.equal(p2?.lastContact, `${y}-${m}-${d}`);
});

test('был: с явным годом сохраняется как есть', () => {
  const p = parsePerson('Тест Тестов был:02.07.2025');
  assert.equal(p?.lastContact, '2025-07-02');
});

test('parsePerson: битая дата др не роняет разбор остального', () => {
  const p = parsePerson('Аня Соколова #бег круг:2 др:31.11 город:Москва');
  assert.equal(p?.name, 'Аня Соколова');
  assert.equal(p?.birthday, undefined);
  assert.equal(p?.city, 'Москва');
});
