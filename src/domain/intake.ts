import { db } from '../db/index.js';
import * as settings from '../db/repo/settings.js';
import { today } from './dates.js';

/**
 * Разметка базы вручную по несколько человек в день.
 * Порядок вспоминания важнее скорости: люди достаются из памяти
 * не по алфавиту, а по контексту — кластерами.
 */
export const RECALL_PROMPTS = [
  'Ближний круг: кому ты звонишь, когда случилось что-то плохое.',
  'Родня по своей линии, включая двоюродных и тех, кого видишь раз в год.',
  'Родня со стороны девушки — свадьбы, дни рождения, кто есть кто.',
  'Беговой клуб: с кем бегал или переписывался за последний год.',
  'Забеги: с кем стоял на старте, кто подвозил, кто снимал жильё вместе.',
  'Текущая работа: своя команда, соседний отдел, руководитель.',
  'Прошлое место работы — пройди по отделам, как по этажам.',
  'Место работы до него. Кто-то из них до сих пор написал бы тебе.',
  'Универ: кто сидел рядом, кто в общаге, кто в вашей курсовой группе.',
  'Школа: с кем реально сохранилась связь, а не просто помнишь имя.',
  'Соседи — нынешние и по прошлым квартирам.',
  'Бишкек и поездки: кого ты там знаешь, кто звал в гости.',
  'Шахматы: турниры, онлайн-соперники, с кем разбирали партии.',
  'Открой поздравления с прошлого дня рождения — там готовый список.',
  'Общие чаты, где ты состоишь: кто там пишет чаще других.',
  'Кого ты за последний год сам кому-то представлял. Это твои коннекторы.',
  'Мастера и специалисты, которых ты кому-то рекомендовал.',
  'Кто помогал тебе за последние два года — и ты этого не забыл.',
  'Последние три поездки: с кем ездил, кого встретил.',
  'Люди, о которых ты недавно вспоминал, но так и не написал.',
];

export interface IntakeState {
  total: number;
  target: number;
  quota: number;
  addedToday: number;
  withoutContact: number;
  prompt: string;
}

export function state(): IntakeState {
  const now = today();
  const total = (db.prepare("SELECT COUNT(*) AS n FROM person WHERE status = 'active' AND is_stub = 0").get() as { n: number }).n;
  const addedToday = (db.prepare(
    "SELECT COUNT(*) AS n FROM person WHERE date(created_at) = ? AND is_stub = 0",
  ).get(now) as { n: number }).n;
  const withoutContact = (db.prepare(`
    SELECT COUNT(*) AS n FROM person p
    WHERE p.status = 'active' AND p.is_stub = 0
      AND NOT EXISTS (SELECT 1 FROM interaction i WHERE i.person_id = p.id)
  `).get() as { n: number }).n;

  const cursor = settings.getNumber('prompt_cursor', 0);
  return {
    total,
    target: settings.getNumber('intake_target', 200),
    quota: settings.getNumber('intake_quota', 5),
    addedToday,
    withoutContact,
    prompt: RECALL_PROMPTS[cursor % RECALL_PROMPTS.length]!,
  };
}

export function nextPrompt(): string {
  const cursor = settings.getNumber('prompt_cursor', 0) + 1;
  settings.set('prompt_cursor', cursor);
  return RECALL_PROMPTS[cursor % RECALL_PROMPTS.length]!;
}

export function done(s: IntakeState): boolean {
  return s.total >= s.target;
}
