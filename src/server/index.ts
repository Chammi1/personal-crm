import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { config } from '../config.js';
import { isOwner, verifyInitData } from './auth.js';
import { api } from './api.js';
import { sync } from './sync.js';
import { AVATAR_DIR } from './avatars.js';

const require = createRequire(import.meta.url);
const app = new Hono();

/**
 * Ограничение частоты: 240 запросов в минуту с одного адреса на /api и /sync.
 * Подпись initData — основная защита, это страховка от перебора и залипших циклов.
 */
const rateWindow = new Map<string, { count: number; since: number }>();
const rateLimit: MiddlewareHandler = async (c, next) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  const nowMs = Date.now();
  const slot = rateWindow.get(ip);
  if (!slot || nowMs - slot.since > 60_000) {
    rateWindow.set(ip, { count: 1, since: nowMs });
  } else if (++slot.count > 240) {
    return c.json({ error: 'слишком часто, подожди минуту' }, 429);
  }
  if (rateWindow.size > 1000) rateWindow.clear(); // страховка от распухания
  return next();
};
app.use('/api/*', rateLimit);
app.use('/sync/*', rateLimit);

/**
 * Доступ к API только владельцу по подписанной initData.
 * ALLOW_INSECURE=1 отключает проверку — режим только для локальной отладки
 * в обычном браузере, на боевом сервере включать нельзя.
 */
app.use('/api/*', async (c, next) => {
  if (config.allowInsecure) return next();

  const initData = c.req.header('X-Telegram-Init-Data') ?? '';
  const { ok, userId } = verifyInitData(initData);
  if (!ok || !isOwner(userId)) return c.json({ error: 'forbidden' }, 403);
  return next();
});

app.route('/api', api);

// Приём данных из СОТА CRM. Своя защита по SYNC_TOKEN — сюда стучится сервер,
// а не браузер, и подписанного initData у него нет.
app.route('/sync', sync);

// Vue отдаём со своего же сервера, а не с CDN: меньше зависимостей от сети.
app.get('/vendor/vue.js', (c) => {
  const path = require.resolve('vue/dist/vue.esm-browser.prod.js');
  return c.body(readFileSync(path), 200, { 'Content-Type': 'application/javascript; charset=utf-8' });
});

// Аватары лежат в томе с базой, а не в public — иначе терялись бы при пересборке.
app.get('/avatars/:file', (c) => {
  const file = c.req.param('file').replace(/[^\w.-]/g, '');
  const path = join(AVATAR_DIR, file);
  if (!existsSync(path)) return c.notFound();
  return c.body(readFileSync(path), 200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'public, max-age=86400',
  });
});

// Telegram цепко кэширует файлы мини-аппов: после деплоя пользователь неделями
// видел бы старый интерфейс. no-cache заставляет WebView проверять свежесть при
// каждом открытии — файлы маленькие, цена копеечная, зато обновления мгновенные.
app.use('/*', async (c, next) => {
  await next();
  const path = new URL(c.req.url).pathname;
  if (path === '/' || /\.(js|css|html)$/.test(path)) {
    c.header('Cache-Control', 'no-cache, must-revalidate');
  }
});
app.use('/*', serveStatic({ root: './public' }));

export function startServer(): void {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[web] мини-апп на порту ${info.port}${config.allowInsecure ? ' (проверка initData ОТКЛЮЧЕНА)' : ''}`);
  });
}
