import type { Circle } from '../db/types.js';

/**
 * Слои Данбара. Ёмкость кумулятивная в оригинале, здесь хранится
 * размер самого слоя — так проще считать переполнение.
 * Интервалы — стартовые значения, у каждого человека переопределяются.
 */
export const CIRCLES: Record<Circle, { label: string; cap: number; interval: number }> = {
  0: { label: 'Ядро',          cap: 5,   interval: 14 },
  1: { label: 'Близкие',       cap: 10,  interval: 21 },
  2: { label: 'Друзья',        cap: 35,  interval: 60 },
  3: { label: 'Активная сеть', cap: 100, interval: 120 },
  4: { label: 'Знакомые',      cap: 350, interval: 365 },
};

export const isCircle = (n: number): n is Circle => n >= 0 && n <= 4 && Number.isInteger(n);

export function intervalFor(circle: Circle, override: number | null): number {
  return override ?? CIRCLES[circle].interval;
}
