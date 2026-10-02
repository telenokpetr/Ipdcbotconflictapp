#!/usr/bin/env bash
# Чинит доступ к https://ipdcconflict.r-company.shop: приложение живёт на :3000,
# а nginx (80/443) не запущен/не настроен. Запускать на сервере от root: bash fix-server.sh
set -euo pipefail

DOMAIN="ipdcconflict.r-company.shop"
PORT=3000

echo "==> Приложение на :${PORT}"
systemctl list-unit-files | grep -q '^conflict-app' && {
  systemctl enable --now conflict-app
  systemctl is-active conflict-app
} || echo "!! unit conflict-app не найден — приложение запущено вручную? (ss -ltnp | grep :${PORT}); запустите deploy.sh"

echo "==> nginx + certbot"
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx
rm -f /etc/nginx/sites-enabled/default
cat > /etc/nginx/sites-available/conflict-app <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    client_max_body_size 2m;
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
systemctl enable --now nginx
systemctl reload nginx

echo "==> Файрвол"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp; ufw allow 'Nginx Full'
fi

echo "==> HTTPS (Let's Encrypt, автопродление ставит certbot.timer)"
certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}" --redirect \
  || echo "!! certbot не отработал — проверьте, что ${DOMAIN} -> $(curl -s https://api.ipify.org) и порт 80 открыт у хостера"
systemctl enable --now certbot.timer 2>/dev/null || true

echo "==> Проверка"
curl -s -o /dev/null -w "local http: %{http_code}\n" -H "Host: ${DOMAIN}" http://127.0.0.1/
systemctl is-enabled nginx conflict-app
ss -ltnp | grep -E ':(80|443|'"${PORT}"') '
