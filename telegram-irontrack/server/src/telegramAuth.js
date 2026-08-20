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

function telegramAuthMiddleware(req, res, next) {
  const skip = String(process.env.SKIP_TELEGRAM_AUTH || 'false').toLowerCase() === 'true';
  const initData = req.header('X-Telegram-Init-Data') || '';

  if (skip) {
    req.telegramUser = { id: 'dev', first_name: 'Dev' };
    return next();
  }

  const result = verifyInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!result.ok) {
    return res.status(401).json({ error: 'Не удалось подтвердить запрос из Telegram: ' + result.reason });
  }

  const allowedIdsRaw = String(process.env.ALLOWED_TELEGRAM_IDS || '').trim();
  if (allowedIdsRaw) {
    const allowed = allowedIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const uid = result.user && result.user.id !== undefined ? String(result.user.id) : null;
    if (!uid || allowed.indexOf(uid) === -1) {
      return res.status(403).json({ error: 'Этому Telegram-аккаунту не разрешён доступ к приложению' });
    }
  }

  req.telegramUser = result.user;
  next();
}

module.exports = { verifyInitData, telegramAuthMiddleware };
