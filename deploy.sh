#!/usr/bin/env bash
# Деплой conflict-diagnostic-app на чистый Ubuntu VPS.
# Запускать от root на самом сервере (185.246.220.102):
#   curl -fsSL https://raw.githubusercontent.com/telenokpetr/ipdcbotconflictapp/main/deploy.sh | bash
# или скопировать файл на сервер и запустить `bash deploy.sh`.

set -euo pipefail

DOMAIN="ipdcconflict.r-company.shop"
APP_DIR="/var/www/conflict-app"
REPO_URL="https://github.com/telenokpetr/ipdcbotconflictapp.git"
PORT=3000
ADMIN_TOKEN="$(openssl rand -hex 32)"

echo "==> Устанавливаю Node.js 18+"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Устанавливаю git, nginx, certbot"
apt-get update
apt-get install -y git nginx certbot python3-certbot-nginx

echo "==> Разворачиваю код в ${APP_DIR}"
if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" pull --ff-only
else
  git clone --depth 1 "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"
npm install --production

echo "==> Создаю systemd-сервис"
cat > /etc/systemd/system/conflict-app.service <<EOF
[Unit]
Description=Conflict diagnostic app
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=ADMIN_TOKEN=${ADMIN_TOKEN}
User=www-data

[Install]
WantedBy=multi-user.target
EOF

chown -R www-data:www-data "${APP_DIR}"
systemctl daemon-reload
systemctl enable --now conflict-app

echo "==> Настраиваю nginx для ${DOMAIN}"
cat > /etc/nginx/sites-available/conflict-app <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf /etc/nginx/sites-available/conflict-app /etc/nginx/sites-enabled/conflict-app
nginx -t
systemctl reload nginx

echo "==> Выпускаю HTTPS-сертификат (Let's Encrypt)"
certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m admin@"${DOMAIN}" --redirect || \
  echo "!! certbot не отработал — проверь вручную: certbot --nginx -d ${DOMAIN}"

echo "==> Открываю порт в ufw (если активен)"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full'
fi

echo ""
echo "======================================================"
echo "Готово."
echo "URL:          https://${DOMAIN}"
echo "Admin panel:  https://${DOMAIN}/admin.html"
echo "ADMIN_TOKEN:  ${ADMIN_TOKEN}"
echo "  (сохраните этот токен — он не выводится повторно;"
echo "   посмотреть можно: systemctl cat conflict-app | grep ADMIN_TOKEN)"
echo "Статус сервиса: systemctl status conflict-app"
echo "======================================================"
