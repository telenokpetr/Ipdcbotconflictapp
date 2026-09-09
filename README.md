# Диагностика «Конфликт интересов» — веб-приложение

Node.js + Express бэкенд и веб-интерфейс. Хранение данных — в JSON-файле
(`data/participants.json`), без внешней БД — проще разворачивать на любом VPS.

## Структура

```
server.js         — API и раздача статики
db.js             — файловое хранилище участников
public/index.html — веб-интерфейс (6 экранов сценария)
public/admin.html — просмотр регистраций/результатов (по токену)
data/             — создаётся автоматически при первом запуске
```

## Локальный запуск

```bash
npm install
ADMIN_TOKEN=ваш-токен PORT=3000 node server.js
```

Открыть `http://localhost:3000` — сам опросник, `http://localhost:3000/admin.html` — админка.

## Деплой на VPS

1. **Установите Node.js 18+** (если ещё нет):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
   sudo apt-get install -y nodejs
   ```

2. **Скопируйте проект на сервер** (например, через `scp` или `git`):
   ```bash
   scp -r conflict-app user@your-server:/var/www/conflict-app
   ```

3. **Установите зависимости на сервере**:
   ```bash
   cd /var/www/conflict-app
   npm install --production
   ```

4. **Задайте переменные окружения.** Не используйте значение по умолчанию для токена админки:
   ```bash
   export ADMIN_TOKEN="длинная-случайная-строка"
   export PORT=3000
   ```
   Либо создайте файл `/etc/systemd/system/conflict-app.service` (см. ниже) и укажите переменные там.

5. **Запустите как systemd-сервис**, чтобы приложение поднималось после перезагрузки и при падении:

   `/etc/systemd/system/conflict-app.service`:
   ```ini
   [Unit]
   Description=Conflict diagnostic app
   After=network.target

   [Service]
   Type=simple
   WorkingDirectory=/var/www/conflict-app
   ExecStart=/usr/bin/node server.js
   Restart=on-failure
   Environment=PORT=3000
   Environment=ADMIN_TOKEN=длинная-случайная-строка
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```

   Затем:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now conflict-app
   sudo systemctl status conflict-app
   ```

6. **Настройте nginx как реверс-прокси** (чтобы отдать наружу порт 80/443 и повесить HTTPS):

   `/etc/nginx/sites-available/conflict-app`:
   ```nginx
   server {
       listen 80;
       server_name your-domain.ru;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }
   ```
   ```bash
   sudo ln -s /etc/nginx/sites-available/conflict-app /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d your-domain.ru   # для HTTPS через Let's Encrypt
   ```

## Резервное копирование данных

Все регистрации и результаты лежат в `data/participants.json`. Периодически
копируйте этот файл (например, cron + `rsync` на другой сервер или в облако) —
это единственное место, где хранятся данные участников.

## Просмотр регистраций

`https://your-domain.ru/admin.html` → ввести `ADMIN_TOKEN` → таблица участников
с профилем, статусом брони и датами.

## Если поток вырастет

Файловое хранилище рассчитано на умеренный поток (десятки-сотни записей в день,
один процесс Node). Если станет тесно — замените `db.js` на реальную БД
(Postgres/SQLite): интерфейс из пяти функций (`createParticipant`,
`findParticipant`, `saveResult`, `markBooked`, `listParticipants`) переносится
без изменений в `server.js`.

## Правки контента

- Вопросы теста и профили: в начале `public/index.html` (`QUESTIONS`, `PROFILES`)
  **и** в `server.js` (`QUESTION_CATEGORIES`) — категории должны совпадать в обоих
  местах, иначе результат на клиенте и на сервере разойдётся.
- Даты/время тренинга, ссылка на подробности: в `public/index.html`, экран 6.
- Текст согласия на обработку данных: экран 2 (`.consent span`).
