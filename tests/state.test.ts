/**
 * Состояние диалога бота: должно жить в БД, а не в памяти процесса.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['BOT_TOKEN'] ??= 'test-token';
process.env['OWNER_ID'] ??= '1';
process.env['DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'crm-state-')), 'test.db');

const state = await import('../src/bot/state.js');
const settings = await import('../src/db/repo/settings.js');

test('pending пишется в settings и читается один раз', () => {
  state.setPending({ type: 'contact_note', personId: 7 });
  // именно в БД, а не в переменной модуля — иначе перезапуск всё потеряет
  assert.equal(
    settings.get('bot_pending', ''),
    JSON.stringify({ type: 'contact_note', personId: 7 }),
  );
  assert.deepEqual(state.takePending(), { type: 'contact_note', personId: 7 });
  assert.equal(state.takePending(), null);
});

test('clearPending снимает ожидание', () => {
  state.setPending({ type: 'note', personId: 3 });
  state.clearPending();
  assert.equal(state.takePending(), null);
});

test('current person хранится в settings', () => {
  assert.equal(state.getCurrent(), null);
  state.setCurrent(42);
  assert.equal(state.getCurrent(), 42);
  assert.equal(settings.get('bot_current', ''), '42');
});

test('битый JSON в pending не роняет обработчик', () => {
  settings.set('bot_pending', 'не json');
  assert.equal(state.takePending(), null);
});
