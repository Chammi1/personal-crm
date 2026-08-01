import type { Circle } from '../db/types.js';
import { isCircle } from './circles.js';
import { today } from './dates.js';

export interface ParsedPerson {
  name: string;
  circle?: Circle;
  city?: string;
  telegram?: string;
  phone?: string;
  birthday?: string;   // YYYY-MM-DD, год-заглушка если не указан
  lastContact?: string; // YYYY-MM-DD — когда последний раз общались
  tags: string[];
  context?: string;
}

/**
 * Разбор строки быстрого добавления:
 *   Аня Соколова #бег #тренер круг:2 др:12.04 был:02.07 тг:@anya город:Москва "познакомились на забеге"
 * Всё, что не распознано как ключ, считается именем.
 */
export function parsePerson(input: string): ParsedPerson | null {
  const out: ParsedPerson = { name: '', tags: [] };

  let rest = input.trim();

  const quoted = rest.match(/"([^"]+)"|«([^»]+)»/);
  if (quoted) {
    out.context = (quoted[1] ?? quoted[2])!.trim();
    rest = rest.replace(quoted[0], ' ');
  }

  const words: string[] = [];
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    if (token.startsWith('#')) { out.tags.push(token.slice(1).toLowerCase()); continue; }

    const kv = token.match(/^([a-zA-Zа-яА-Я]+):(.+)$/);
    if (kv) {
      const key = kv[1]!.toLowerCase();
      const value = kv[2]!;
      switch (key) {
        case 'круг': case 'circle': {
          const n = Number(value);
          if (isCircle(n)) out.circle = n;
          continue;
        }
        case 'др': case 'bd': {
          const bd = parseBirthday(value);
          if (bd) out.birthday = bd;
          continue;
        }
        case 'был': case 'была': case 'last': {
          const d = parseBirthday(value);
          if (!d) continue;
          let last = d.startsWith('1900') ? String(new Date().getFullYear()) + d.slice(4) : d;
          // «был:30.12», введённый летом — это прошлый декабрь, а не будущий:
          // дата контакта в будущем прятала бы человека из тишины до зимы.
          if (last > today() && d.startsWith('1900')) {
            last = String(Number(last.slice(0, 4)) - 1) + last.slice(4);
          }
          out.lastContact = last;
          continue;
        }
        case 'тг': case 'tg': out.telegram = value.replace(/^@/, ''); continue;
        case 'тел': case 'phone': out.phone = value; continue;
        case 'город': case 'city': out.city = value; continue;
        default: break;
      }
    }
    words.push(token);
  }

  out.name = words.join(' ').trim();
  return out.name ? out : null;
}

/** Принимает 12.04, 12.04.1991, 1991-04-12. Без года ставит 1900 как маркер «год неизвестен». */
export function parseBirthday(s: string): string | null {
  let m = s.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{4}))?$/);
  if (m) {
    const [, d, mo, y] = m;
    return validDate(y ?? '1900', mo!, d!);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? validDate(m[1]!, m[2]!, m[3]!) : null;
}

// 29 февраля разрешено даже без года: год-заглушка 1900 не високосный,
// но nextOccurrence клампит день, а реальный год рождения мог быть високосным.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * 31.11 или 13-й месяц не должны попадать в базу: из такой строки
 * Date даёт NaN, и событие навсегда молча выпадает из всех сигналов.
 */
function validDate(y: string, mo: string, d: string): string | null {
  const m = Number(mo), day = Number(d);
  if (m < 1 || m > 12 || day < 1 || day > DAYS_IN_MONTH[m - 1]!) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
