import { config } from '../config.js';

/**
 * Разбор расшифрованной голосовой заметки в поля карточки.
 *
 * «Встретил Аню, у неё марафон в сентябре, обещал скинуть контакт врача» →
 * контакт (встреча) + зацепка в досье + обещание. Модель дешёвая (gpt-4o-mini),
 * ответ — строгий JSON. Любая ошибка = null, и заметка сохраняется целиком,
 * как раньше: разбор — улучшение, а не точка отказа.
 */

export interface VoiceParsed {
  /** имя знакомого, если явно прозвучало (для поиска по базе) */
  name: string | null;
  /** был ли факт общения и какой канал */
  contact: 'message' | 'call' | 'meeting' | null;
  /** суть для заметки */
  note: string | null;
  dossier: Partial<Record<'family' | 'occupation' | 'recreation' | 'dreams' | 'hooks' | 'avoid' | 'gift_ideas', string>>;
  task: { direction: 'i_owe' | 'they_owe'; body: string; dueDays: number | null } | null;
}

const SYSTEM = `Ты разбираешь голосовую заметку владельца личной CRM о его знакомом.
Верни СТРОГО JSON без пояснений:
{
 "name": string|null,        // имя знакомого, если явно упомянуто (только имя/имя+фамилия, не местоимения)
 "contact": "message"|"call"|"meeting"|null,  // только если общение УЖЕ состоялось: переписка/звонок/встреча
 "note": string|null,        // краткая суть события своими словами заметки, 1-2 предложения
 "dossier": {                // только то, что ЯВНО прозвучало как факт о человеке; пустые поля не включай
   "family": string,         // семья: жена, дети, родители
   "occupation": string,     // работа, профессия
   "recreation": string,     // увлечения
   "dreams": string,         // планы, цели, мечты
   "hooks": string,          // темы для следующего разговора: события в его жизни, марафон, переезд
   "avoid": string,          // о чём не стоит говорить
   "gift_ideas": string      // идеи подарков
 },
 "task": {"direction":"i_owe"|"they_owe","body":string,"dueDays":number|null} | null
                             // обещание: i_owe если обещал владелец («я обещал скинуть»), they_owe если знакомый
}
Ничего не выдумывай: нет факта — нет поля.`;

export async function parseVoiceNote(text: string): Promise<VoiceParsed | null> {
  if (!config.openaiKey) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;

    const p = JSON.parse(raw) as Partial<VoiceParsed>;
    const CHANNELS = ['message', 'call', 'meeting'];
    return {
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null,
      contact: CHANNELS.includes(p.contact as string) ? p.contact as VoiceParsed['contact'] : null,
      note: typeof p.note === 'string' && p.note.trim() ? p.note.trim() : null,
      dossier: typeof p.dossier === 'object' && p.dossier ? p.dossier : {},
      task: p.task && typeof p.task === 'object' && typeof p.task.body === 'string'
        ? {
            direction: p.task.direction === 'they_owe' ? 'they_owe' : 'i_owe',
            body: p.task.body,
            dueDays: Number.isFinite(p.task.dueDays) ? Number(p.task.dueDays) : null,
          }
        : null,
    };
  } catch {
    return null;
  }
}
