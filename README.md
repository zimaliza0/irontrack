# IronTrack — Telegram Mini App

Перенос вашего приложения из Google Sheets Web App в Telegram Mini App.
Таблица и её структура остаются теми же — меняется только способ доступа к ней:
вместо `google.script.run` (доступен только внутри Apps Script) бэкенд на Node.js
читает и пишет в ту же Google Таблицу через Google Sheets API.

```
telegram-irontrack/
  server/     — бэкенд (Node.js/Express), заменяет функции из Code.gs
  webapp/     — index.html мини-аппа (почти тот же UI, что и был)
```

## Быстрый локальный запуск (без Google, без Telegram)

Для теста на ПК Google Sheets вообще не нужен — есть локальный режим хранения
данных (простой JSON-файл на диске). Дальше, когда всё устроит, можно
переключиться на Google Sheets (`DB_DRIVER=sheets`) или синхронизировать
данные вручную — не обязательно делать это сразу.

```bash
cd server
npm install
cp .env.example .env
npm start
```

Откройте **http://localhost:3000** в обычном браузере — сервер сам раздаёт
и API, и интерфейс (`webapp/index.html`) с одного адреса, ничего
дополнительно настраивать не нужно. В `.env.example` уже стоит
`DB_DRIVER=local` и `SKIP_TELEGRAM_AUTH=true` — то есть приложение работает
как обычная веб-страница, без проверки Telegram.

Данные сохраняются в `server/data/db.json` — можно открыть текстом,
посмотреть что там, стереть файл (пересоздастся пустым при следующем
запуске) или сделать бэкап копированием файла.

Когда захотите протестировать именно как Telegram Mini App (с кнопкой
"Назад", темой оформления и т.д.) — воспользуйтесь
[ngrok](https://ngrok.com/) или похожим туннелем, чтобы получить HTTPS-адрес
для вашего localhost, и укажите его в @BotFather (см. Шаг 2 и 4 ниже). Это
уже необязательно для базового теста логики приложения.

---

## Позже: перенос на сервер + подключение реального Telegram-бота

Дальше — как было раньше: разворачиваете `server/` на настоящем хостинге,
опционально переключаетесь на `DB_DRIVER=sheets`, чтобы данные жили в Google
Таблице, и регистрируете Mini App в @BotFather.

## Как это работает

`webapp/index.html` содержит небольшой "шим" — объект `google.script.run`,
который выглядит и вызывается точно так же, как в оригинале
(`google.script.run.withSuccessHandler(...).getAppData()`), но внутри делает
`fetch()` к вашему серверу. Поэтому почти весь остальной JS-код в файле не
трогали — риск что-то сломать минимальный.

---

## Шаг 1. Сервисный аккаунт Google (доступ к таблице из кода)

1. Откройте [Google Cloud Console](https://console.cloud.google.com/) → создайте
   проект (или используйте существующий).
2. Включите **Google Sheets API**: APIs & Services → Library → найдите
   "Google Sheets API" → Enable.
3. Создайте сервисный аккаунт: APIs & Services → Credentials → Create
   Credentials → Service account. Имя — любое, например `irontrack-bot`.
4. Откройте созданный сервисный аккаунт → вкладка **Keys** → Add Key → Create
   new key → тип **JSON**. Скачается файл — он понадобится дальше.
5. В скачанном JSON найдите поля `client_email` и `private_key` — это
   `GOOGLE_SERVICE_ACCOUNT_EMAIL` и `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`.
6. Откройте вашу Google Таблицу → кнопка **Настройки доступа (Share)** →
   добавьте email сервисного аккаунта (из п.5) с правами **Редактор**.
7. Скопируйте `GOOGLE_SHEET_ID` из адресной строки таблицы:
   `https://docs.google.com/spreadsheets/d/ЭТОТ_КУСОК/edit`.

## Шаг 2. Бот в Telegram

1. В Telegram напишите [@BotFather](https://t.me/BotFather) → `/newbot`,
   следуйте инструкциям, получите **токен бота** (`TELEGRAM_BOT_TOKEN`).
2. Настройте Mini App: `/newapp` (или `/mybots` → выберите бота → Bot
   Settings → Menu Button / Mini App), укажите URL, куда вы задеплоите
   `webapp/index.html` (см. Шаг 4).

## Шаг 3. Деплой бэкенда (`server/`)

Подойдёт любой Node.js-хостинг: Render, Railway, Fly.io, обычный VPS.
Пример для **Render.com** (бесплатный тариф подходит для старта):

1. Залейте папку `server/` в свой GitHub-репозиторий.
2. На Render: New → Web Service → подключите репозиторий.
   - Build Command: `npm install`
   - Start Command: `npm start`
3. В разделе Environment добавьте переменные из `.env.example`:
   `TELEGRAM_BOT_TOKEN`, `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
   `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (ключ вставляйте с `\n` как есть, в
   кавычках), `ALLOWED_TELEGRAM_IDS` (свой Telegram numeric ID — узнать можно
   у бота [@userinfobot](https://t.me/userinfobot)), `SKIP_TELEGRAM_AUTH=false`.
4. Деплой запустится автоматически. Проверьте `https://ваш-сервис.onrender.com/health`
   — должно вернуть `{"ok":true}`.

## Шаг 4. Деплой фронтенда (`webapp/index.html`)

Это статический файл — подойдёт GitHub Pages, Netlify, Vercel, Cloudflare
Pages, или тот же Render (Static Site).

1. В файле `webapp/index.html` найдите строку:
   ```js
   const API_BASE = window.IRONTRACK_API_BASE || 'https://REPLACE-WITH-YOUR-BACKEND-URL';
   ```
   Замените `REPLACE-WITH-YOUR-BACKEND-URL` на реальный адрес из Шага 3
   (например `https://irontrack-api.onrender.com`).
2. Задеплойте файл — получите публичный HTTPS-адрес
   (обязательно HTTPS, Telegram Mini App не откроет http).
3. Вернитесь к @BotFather → укажите этот адрес как URL Mini App.

## Шаг 5. Проверка

1. Откройте бота в Telegram → нажмите кнопку меню/Mini App.
2. Приложение должно загрузить те же данные, что были в Google Sheets
   версии — пользователей, шаблоны, тренировки.
3. Если видите ошибку авторизации — проверьте `TELEGRAM_BOT_TOKEN` и что вы
   заходите именно через Telegram (не просто открываете ссылку в браузере —
   тогда `initData` не будет сформирован; для теста в браузере временно
   поставьте `SKIP_TELEGRAM_AUTH=true` на бэкенде).

---

## Ограничения этой MVP-версии (о чём стоит знать)

- **Один "оператор" на приложение.** Как и в исходной Google Sheets версии,
  список спортсменов — общий, конкретный Telegram-пользователь не привязан
  к конкретному `UserID` в таблице. Это подходит, если приложением пользуется
  один тренер и ведёт разных клиентов. Если нужно, чтобы каждый клиент видел
  только свои данные под своим Telegram-аккаунтом — понадобится добавить
  колонку `TelegramID` в лист "Пользователи" и фильтрацию на бэкенде;
  могу добавить отдельным шагом.
- **`ALLOWED_TELEGRAM_IDS`** — простой список ID, кому вообще разрешено
  пользоваться ботом (не путать с привязкой к конкретному спортсмену выше).
  Оставьте пустым на этапе тестов, заполните перед реальным использованием.
- **Google Sheets API имеет лимиты** (по умолчанию ~300 запросов/мин на
  проект) — для одного тренера с несколькими клиентами этого с большим
  запасом достаточно.
- **Список упражнений/шаблонов подгружается целиком при каждом действии**
  (как и в оригинале) — при очень большой базе (тысячи строк) стоит подумать
  о серверном кэшировании, но для типичного объёма данных (десятки-сотни
  строк) это не будет заметно.
