/**
 * Импорт базы из CSV. Запуск: npm run import -- ./people.csv
 *
 * Колонки (первая строка — заголовок, порядок любой, лишние игнорируются):
 *   name, circle, city, telegram, phone, tags, birthday, last_contact, context
 *   tags — через точку с запятой: бег;универ
 *   birthday — 12.04 или 12.04.1991
 *   last_contact — YYYY-MM-DD, дата последнего общения; без неё человек сразу уйдёт в просрочку
 */
import { readFileSync } from 'node:fs';
import { migrate } from '../src/db/index.js';
import { isCircle } from '../src/domain/circles.js';
import { parseBirthday } from '../src/domain/parse.js';
import * as people from '../src/db/repo/people.js';
import * as timeline from '../src/db/repo/timeline.js';
import * as agenda from '../src/db/repo/agenda.js';

function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }

  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), (r[i] ?? '').trim()])));
}

const file = process.argv[2];
if (!file) {
  console.error('Укажи файл: npm run import -- ./people.csv');
  process.exit(1);
}

migrate();

const rows = parseCSV(readFileSync(file, 'utf8'));
let added = 0, skipped = 0;

for (const r of rows) {
  const name = r['name'];
  if (!name) { skipped++; continue; }

  const circleRaw = Number(r['circle'] ?? 3);
  const circle = isCircle(circleRaw) ? circleRaw : 3;

  const id = people.create({
    name,
    circle,
    city: r['city'] || null,
    telegram: (r['telegram'] || '').replace(/^@/, '') || null,
    phone: r['phone'] || null,
    met_context: r['context'] || null,
    tags: (r['tags'] || '').split(';').map((t) => t.trim()).filter(Boolean),
  });

  const bd = r['birthday'] ? parseBirthday(r['birthday']) : null;
  if (bd) agenda.addEvent(id, 'birthday', bd, { recurring: true });

  const last = r['last_contact'];
  if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) {
    timeline.logInteraction(id, 'message', { on: last, summary: 'импорт' });
  }
  added++;
}

console.log(`Импортировано: ${added}, пропущено: ${skipped}`);
console.log('Дальше: /stats в боте покажет, как легли круги.');
