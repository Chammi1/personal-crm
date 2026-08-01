import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения ${name}. Скопируй .env.example в .env и заполни.`);
  return v;
}

// TZ процесса выравнивается с настройкой ДО первых вызовов Date: иначе в
// контейнере без TZ крон дайджеста шёл бы по Москве (fallback ниже), а расчёт
// дат — по UTC, и утренняя рассылка строилась бы на «вчера».
process.env.TZ = process.env.TZ ?? 'Europe/Moscow';

export const config = {
  botToken: required('BOT_TOKEN'),
  ownerId: Number(required('OWNER_ID')),
  dbPath: process.env.DB_PATH ?? './data/crm.db',
  timezone: process.env.TZ ?? 'Europe/Moscow',
  digestHour: Number(process.env.DIGEST_HOUR ?? 10),
  port: Number(process.env.PORT ?? 3000),
  publicUrl: process.env.PUBLIC_URL ?? '',
  allowInsecure: process.env.ALLOW_INSECURE === '1',
  // Общий секрет для приёма данных из СОТА CRM. Пусто = синхронизация выключена.
  syncToken: process.env.SYNC_TOKEN ?? '',
  // Ключ OpenAI для расшифровки голосовых. Пусто = голосовые не расшифровываются.
  openaiKey: process.env.OPENAI_API_KEY ?? '',
};
