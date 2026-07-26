import { createHmac } from 'node:crypto';
import { config } from '../config.js';

/**
 * Проверка initData из Telegram Mini App.
 * Схема: секрет = HMAC("WebAppData", botToken), затем сверяем подпись строки данных.
 * Без этой проверки любой, кто знает адрес, получил бы доступ к базе.
 */
export function verifyInitData(initData: string): { ok: boolean; userId?: number } {
  if (!initData) return { ok: false };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false };

  params.delete('hash');
  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const signature = createHmac('sha256', secret).update(checkString).digest('hex');
  if (signature !== hash) return { ok: false };

  // Протухшие данные не принимаем: 24 часа с запасом.
  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 86_400) return { ok: false };

  try {
    const user = JSON.parse(params.get('user') ?? '{}') as { id?: number };
    return user.id ? { ok: true, userId: user.id } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function isOwner(userId: number | undefined): boolean {
  return userId === config.ownerId;
}
