// Проверка подлинности данных, которые Telegram передаёт мини-аппу (initData).
// Алгоритм — официальный, описан в документации Telegram:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

const crypto = require('crypto');

function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return { ok: false, reason: 'Нет initData или не задан TELEGRAM_BOT_TOKEN' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'В initData нет hash' };
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return { ok: false, reason: 'Подпись не совпадает' };

  // Telegram присылает initData с ограниченным сроком действия — опционально можно проверять auth_date.
  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch (e) {
    user = null;
  }

  return { ok: true, user };
}

// telegramAuthMiddleware теперь не просто пускает/не пускает по списку ALLOWED_TELEGRAM_IDS,
// а определяет РОЛЬ вызывающего:
//   - 'trainer' — Telegram ID есть в ALLOWED_TELEGRAM_IDS (или список вообще не задан —
//     тогда, как и раньше, доверяем всем, кто прошёл проверку подписи Telegram)
//   - 'athlete' — Telegram ID привязан (поле TelegramID) к конкретному спортсмену в базе;
//     такой пользователь допускается, но только к своим данным — это проверяется уже в
//     конкретных роутах index.js через req.telegramRole / req.telegramAthleteUserId
//   - иначе — 403, доступа нет вообще
// Поэтому мидлвару нужен доступ к драйверу данных (sheets/db-local/db-turso) — передаём
// его как аргумент фабрики.
function createTelegramAuthMiddleware(dataDriver) {
  return async function telegramAuthMiddleware(req, res, next) {
    const skip = String(process.env.SKIP_TELEGRAM_AUTH || 'false').toLowerCase() === 'true';
    const initData = req.header('X-Telegram-Init-Data') || '';

    if (skip) {
      req.telegramUser = { id: 'dev', first_name: 'Dev' };
      req.telegramRole = 'trainer';
      req.telegramAthleteUserId = null;
      return next();
    }

    const result = verifyInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!result.ok) {
      return res.status(401).json({ error: 'Не удалось подтвердить запрос из Telegram: ' + result.reason });
    }
    req.telegramUser = result.user;
    const tgId = result.user && result.user.id !== undefined ? String(result.user.id) : null;

    const allowedIdsRaw = String(process.env.ALLOWED_TELEGRAM_IDS || '').trim();
    const allowed = allowedIdsRaw ? allowedIdsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

    if (!allowedIdsRaw || (tgId && allowed.indexOf(tgId) !== -1)) {
      req.telegramRole = 'trainer';
      req.telegramAthleteUserId = null;
      return next();
    }

    try {
      const data = await dataDriver.getAppData();
      const athlete = (data.users || []).find((u) => String(u.TelegramID || '') === tgId);
      if (athlete) {
        req.telegramRole = 'athlete';
        req.telegramAthleteUserId = athlete.UserID;
        return next();
      }
    } catch (e) {
      // не удалось проверить принадлежность — упадём в 403 ниже
    }

    return res.status(403).json({ error: 'Этому Telegram-аккаунту не разрешён доступ к приложению' });
  };
}

module.exports = { verifyInitData, createTelegramAuthMiddleware };
