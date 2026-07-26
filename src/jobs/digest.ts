import cron from 'node-cron';
import { config } from '../config.js';
import { humanDate, today } from '../domain/dates.js';
import * as signals from '../domain/signals.js';
import { bot } from '../bot/index.js';
import * as ui from '../bot/ui.js';
import { intakeTail } from '../bot/handlers/commands.js';

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function label(): string {
  const d = new Date();
  const w = WEEKDAYS[d.getDay()]!;
  return w[0]!.toUpperCase() + w.slice(1) + ', ' + humanDate(today());
}

export async function sendDigest(): Promise<void> {
  const all = signals.collect();
  const due = signals.due(all);
  const horizon = signals.horizon(all);

  const tail = intakeTail();

  // Пустой день не заслуживает уведомления — если только не идёт разметка,
  // тогда напоминание про норму как раз и есть смысл сообщения.
  if (!due.length && !horizon.length && !tail) return;

  const { text, keyboard } = ui.digest(due, horizon, label(), tail);
  await bot.api.sendMessage(config.ownerId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

export function scheduleDigest(): void {
  const expr = `0 ${config.digestHour} * * *`;
  cron.schedule(expr, () => {
    sendDigest().catch((e) => console.error('[digest] не отправлен:', e));
  }, { timezone: config.timezone });
  console.log(`[digest] запланирован на ${config.digestHour}:00 (${config.timezone})`);
}
