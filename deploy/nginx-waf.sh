#!/bin/bash
# Idempotent WAF-lite (nginx rate limits + blocked paths) and fail2ban (login 401/429 + sshd).
# Validates with nginx -t and reverts the app site on failure. Never prints secrets.
# Called from server-hook.sh as root; the hook treats a non-zero exit as non-fatal.
set -e
D=$(cd "$(dirname "$0")" && pwd)
command -v nginx >/dev/null || { echo "nginx-waf: nginx not installed"; exit 0; }
install -m 644 "$D/nginx/ownfield-waf-http.conf" /etc/nginx/conf.d/ownfield-waf-zones.conf
install -d /etc/nginx/snippets
install -m 644 "$D/nginx/ownfield-waf-server.conf" /etc/nginx/snippets/ownfield-waf.conf
F=$(readlink -f "$(grep -lE 'server_name[^;]*sslip\.io' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null | head -1)" 2>/dev/null)
if [ -n "$F" ] && [ -f "$F" ]; then
  if ! grep -q 'snippets/ownfield-waf.conf' "$F"; then
    cp "$F" "$F.prev-waf"
    awk 'BEGIN{inc="  include /etc/nginx/snippets/ownfield-waf.conf;"}
      /include \/etc\/nginx\/snippets\/ownfield-waf.conf;/ { print; next }
      $0 ~ /server[[:space:]]*\{/ { print; print inc; next }
      { print }' "$F" > "$F.new-waf"
    mv "$F.new-waf" "$F"
    echo "nginx-waf: include added to app site"
  fi
else
  echo "nginx-waf: app site not found; http zones installed only"
fi
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  [ -n "$F" ] && rm -f "$F.prev-waf"
  echo "nginx-waf: nginx reloaded"
else
  echo "nginx-waf: nginx -t failed, reverting site"
  if [ -n "$F" ] && [ -f "$F.prev-waf" ]; then mv "$F.prev-waf" "$F"; fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  echo "nginx-waf: site reverted"
fi
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq fail2ban >/dev/null
install -d /etc/fail2ban/filter.d /etc/fail2ban/jail.d
install -m 644 "$D/fail2ban/ownfield-login.conf" /etc/fail2ban/filter.d/ownfield-login.conf
install -m 644 "$D/fail2ban/ownfield.local" /etc/fail2ban/jail.d/ownfield.conf
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl reload fail2ban >/dev/null 2>&1 || systemctl restart fail2ban >/dev/null 2>&1 || echo "nginx-waf: fail2ban reload failed"
echo "nginx-waf: fail2ban enabled (sshd + login 401/429)"
