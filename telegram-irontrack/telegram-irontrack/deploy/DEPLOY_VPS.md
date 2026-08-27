# Перенос IronTrack на VPS (reg.ru, Ubuntu)

Без своего домена — используем бесплатный `sslip.io`, который превращает ваш IP-адрес
в рабочий домен (нужен для HTTPS, обязательного для Telegram Mini App). Пример: если
IP сервера `203.0.113.45`, то ваш адрес будет `203-0-113-45.sslip.io` — просто замените
точки на дефисы. Ничего регистрировать не нужно, это публичный бесплатный сервис,
резолвящий такие имена сразу на нужный IP.

---

## Шаг 1. Подключение к серверу

На Windows: откройте PowerShell и введите (замените на свои данные, IP и логин — из
панели reg.ru, обычно логин `root`):

```
ssh root@ВАШ_IP_АДРЕС
```

Введите пароль от сервера (из письма/панели reg.ru при заказе VPS). Если это первое
подключение — согласитесь на добавление ключа (`yes`).

## Шаг 2. Установка Node.js и нужных программ

Выполните по очереди прямо в SSH-сессии на сервере:

```bash
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx git
npm install -g pm2
node -v
```

Последняя команда должна показать версию вроде `v20.x.x`.

## Шаг 3. Загрузка проекта на сервер

Проще всего через git — если ваш код уже на GitHub (мы туда заливали раньше):

```bash
cd /opt
git clone https://github.com/ВАШ_ЛОГИН/ВАШ_РЕПОЗИТОРИЙ.git irontrack
cd irontrack/server
npm install
```

Если репозиторий приватный, Git попросит логин/токен (обычный пароль GitHub уже не
работает — нужен Personal Access Token из GitHub → Settings → Developer settings).

**Альтернатива без git** — загрузить файлы напрямую с ПК через WinSCP (бесплатная
программа с интерфейсом как в проводнике, подключается по тем же SSH-данным) — перетащите
папку `telegram-irontrack` в `/opt/irontrack` на сервере.

## Шаг 4. Настройка .env

```bash
cd /opt/irontrack/server
cp .env.example .env
nano .env
```

Впишите те же значения, что были на Render: `DB_DRIVER=turso`, `TURSO_DATABASE_URL`,
`TURSO_AUTH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_IDS=ваш_id_и_только_он`,
`SKIP_TELEGRAM_AUTH=false`. Сохраните: `Ctrl+O`, `Enter`, выйти — `Ctrl+X`.

## Шаг 5. Запуск через pm2 (чтобы сервер жил постоянно и поднимался после перезагрузки)

```bash
cd /opt/irontrack/server
pm2 start src/index.js --name irontrack
pm2 save
pm2 startup
```

Последняя команда выведет ещё одну команду для копирования — скопируйте её целиком и
выполните (это настраивает автозапуск pm2 при перезагрузке сервера).

Проверка: `pm2 status` — сервис `irontrack` должен быть `online`. Логи: `pm2 logs irontrack`.

## Шаг 6. Настройка nginx (реверс-прокси)

Скачайте файл `deploy/nginx-irontrack.conf` из архива, замените в нём `YOUR_HOSTNAME` на
ваш `xxx-xxx-xxx-xxx.sslip.io` (с реальным IP через дефисы), затем на сервере:

```bash
nano /etc/nginx/sites-available/irontrack
```

Вставьте содержимое файла, сохраните (`Ctrl+O`, `Enter`, `Ctrl+X`). Дальше:

```bash
ln -s /etc/nginx/sites-available/irontrack /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

`nginx -t` должен написать `syntax is ok` / `test is successful`.

## Шаг 7. Открыть порты в файрволе (если включён ufw)

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

(Если спросит подтверждение — введите `y`.)

## Шаг 8. Бесплатный HTTPS-сертификат (Let's Encrypt)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d ВАШ-IP-ЧЕРЕЗ-ДЕФИСЫ.sslip.io
```

Certbot спросит email (для уведомлений об истечении сертификата — не обязательно
настоящий) и согласие с условиями. Он сам допишет HTTPS-блок в конфиг nginx.
Сертификат бесплатный и автопродлевается (certbot сам ставит задачу в cron).

## Шаг 9. Проверка

Откройте в браузере `https://ВАШ-IP-ЧЕРЕЗ-ДЕФИСЫ.sslip.io/health` — должно вернуть
`{"ok":true,"driver":"turso"}`.

## Шаг 10. Обновить адрес в Telegram

@BotFather → `/mybots` → ваш бот → Bot Settings → Menu Button → вставьте
`https://ВАШ-IP-ЧЕРЕЗ-ДЕФИСЫ.sslip.io` вместо старого адреса Render.

Откройте бота в Telegram — приложение должно загрузиться уже с вашего сервера, без
Render и без разрывов туннелей, с которыми мы мучились раньше.

---

## Дальнейшие обновления кода

Когда правите код и заливаете новую версию на GitHub, на сервере:

```bash
cd /opt/irontrack
git pull
cd server
npm install
pm2 restart irontrack
```

(Если грузили без git через WinSCP — просто перезалейте изменённые файлы и сделайте
`pm2 restart irontrack`.)

## Полезные команды

- `pm2 status` — жив ли сервис
- `pm2 logs irontrack` — логи в реальном времени (Ctrl+C чтобы выйти)
- `pm2 restart irontrack` — перезапуск после изменений
- `systemctl status nginx` — жив ли nginx
- `nginx -t` — проверка конфига nginx на ошибки перед перезапуском
