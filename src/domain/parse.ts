import type { Circle } from '../db/types.js';
import { isCircle } from './circles.js';

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
          if (d && !d.startsWith('1900')) out.lastContact = d;
          else if (d) out.lastContact = String(new Date().getFullYear()) + d.slice(4);
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
    return `${y ?? '1900'}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? s : null;
}
