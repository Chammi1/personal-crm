import { Bot } from 'grammy';
import { config } from '../config.js';
import { onlyOwner } from './auth.js';
import { callbacks } from './handlers/callbacks.js';
import { commands } from './handlers/commands.js';

export const bot = new Bot(config.botToken);

bot.use(onlyOwner);
bot.use(callbacks);
bot.use(commands);

bot.catch((err) => {
  console.error('[bot] ошибка обработчика:', err.error);
});

export async function setCommandMenu(): Promise<void> {
  // Кнопка мини-аппа в меню чата. Telegram принимает только https.
  if (config.publicUrl.startsWith('https://')) {
    await bot.api.setChatMenuButton({
      chat_id: config.ownerId,
      menu_button: { type: 'web_app', text: 'Круг', web_app: { url: config.publicUrl } },
    });
  } else {
    console.warn('[bot] PUBLIC_URL не задан или не https — кнопка мини-аппа не установлена');
  }

  await bot.api.setMyCommands([
    { command: 'today', description: 'Кому написать сегодня' },
    { command: 'add', description: 'Добавить человека' },
    { command: 'find', description: 'Найти по имени, тегу, факту' },
    { command: 'brief', description: 'Шпаргалка перед разговором' },
    { command: 'cevent', description: 'Коллективное событие кластера' },
    { command: 'stats', description: 'Заполненность кругов' },
    { command: 'app', description: 'Открыть карту кругов' },
    { command: 'backup', description: 'Файл базы в этот чат' },
    { command: 'help', description: 'Как пользоваться' },
  ]);
}
