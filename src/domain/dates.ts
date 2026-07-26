/** Работа с датами в виде YYYY-MM-DD. Часовой пояс берётся из окружения процесса. */

export function today(): string {
  return new Date().toLocaleDateString('sv-SE'); // sv-SE даёт формат ISO
}

export function toISO(d: Date): string {
  return d.toLocaleDateString('sv-SE');
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Ближайшее наступление события.
 * Для повторяющихся подставляет текущий год, а если дата уже прошла — следующий.
 * 29 февраля в невисокосный год съезжает на 28-е.
 */
export function nextOccurrence(eventDate: string, recurring: boolean, from: string): string {
  if (!recurring) return eventDate;
  const [, mm, dd] = eventDate.split('-') as [string, string, string];
  const year = Number(from.slice(0, 4));

  const build = (y: number): string => {
    const month = Number(mm);
    const daysInMonth = new Date(Date.UTC(y, month, 0)).getUTCDate();
    const day = Math.min(Number(dd), daysInMonth);
    return `${y}-${mm}-${String(day).padStart(2, '0')}`;
  };

  const thisYear = build(year);
  return daysBetween(from, thisYear) >= 0 ? thisYear : build(year + 1);
}

const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

export function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return `${Number(d)} ${MONTHS[Number(m) - 1]}${Number(y) !== new Date().getFullYear() ? ' ' + y : ''}`;
}

export function dayMonth(iso: string): string {
  const [, m, d] = iso.split('-') as [string, string, string];
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

export function humanDays(n: number): string {
  if (n < 0) return `${-n} дн назад`;
  if (n === 0) return 'сегодня';
  if (n === 1) return 'завтра';
  if (n === 2) return 'послезавтра';
  return `через ${n} дн`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
