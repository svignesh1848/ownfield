#!/bin/bash
# Custom domains on the hosted nginx (called from server-hook.sh as root). Idempotent; never fails the build.
#  - app.ownfield.in: served by the existing app site, next to the sslip.io name (one expanded Let's Encrypt cert).
#  - ownfield.in, www.ownfield.in: own cert, 301 -> https://app.ownfield.in until a company website exists.
APP=app.ownfield.in; SITE="ownfield.in www.ownfield.in"
command -v nginx >/dev/null && command -v certbot >/dev/null || { echo "domain-setup: nginx/certbot missing"; exit 0; }
IP=$(curl -s -m 5 https://checkip.amazonaws.com | tr -d '[:space:]')
here() { [ -n "$IP" ] && [ "$(getent ahostsv4 "$1" | awk 'NR==1{print $1}')" = "$IP" ]; }
ls /etc/letsencrypt/accounts/*/directory/*/* >/dev/null 2>&1 || EM="--register-unsafely-without-email"
reload() { if nginx -t >/dev/null 2>&1; then systemctl reload nginx; return 0; fi; return 1; }
F=$(readlink -f "$(grep -lE 'server_name[^;]*sslip\.io' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null | head -1)" 2>/dev/null)
[ -n "$F" ] && [ -f "$F" ] || { echo "domain-setup: sslip nginx site not found"; exit 0; }
SSLIP=$(grep -oE '[a-z0-9.-]+\.sslip\.io' "$F" | head -1)
covers() { certbot certificates 2>/dev/null | awk -v n="$1" '/Certificate Name:/{c=$3} /Domains:/{ if (c==n) print }' | grep -qw -- "$2"; }
# 1) app.ownfield.in on the app site (also undo an earlier version that put the apex names here)
if here "$APP"; then
  cp "$F" "$F.prev"
  sed -i -E "/server_name[^;]*sslip\.io/ { s/ (www\.)?ownfield\.in//g; s/ app\.ownfield\.in//g; s/;/ $APP;/ }" "$F"
  if cmp -s "$F" "$F.prev"; then rm -f "$F.prev"; elif reload; then rm -f "$F.prev"; echo "domain-setup: app site server_name updated"; else mv "$F.prev" "$F"; echo "domain-setup: nginx -t failed, reverted"; exit 0; fi
  CN=$(certbot certificates 2>/dev/null | awk -v s="$SSLIP" '/Certificate Name:/{n=$3} /Domains:/{ if (index($0,s)) {print n; exit} }')
  if ! covers "$CN" "$APP" || covers "$CN" "www.ownfield.in"; then
    timeout 180 certbot --nginx -n --agree-tos $EM --cert-name "${CN:-$SSLIP}" --redirect -d "$SSLIP" -d "$APP" && echo "domain-setup: cert $SSLIP + $APP" || echo "domain-setup: app certbot failed"
    reload
  fi
else echo "domain-setup: $APP not pointing here yet"; fi
# 2) apex + www -> redirect to the app
ok=1; for d in $SITE; do here "$d" || ok=0; done
if [ $ok = 1 ]; then
  R=/etc/nginx/sites-available/ownfield-site
  if [ ! -f $R ]; then
    printf 'server {\n  listen 80;\n  listen [::]:80;\n  server_name %s;\n  location /.well-known/acme-challenge/ { root /var/www/html; }\n  location / { return 301 https://%s$request_uri; }\n}\n' "$SITE" "$APP" >$R
    ln -sf $R /etc/nginx/sites-enabled/ownfield-site
    reload || { rm -f /etc/nginx/sites-enabled/ownfield-site $R; echo "domain-setup: redirect site invalid, removed"; exit 0; }
  fi
  if ! covers ownfield.in www.ownfield.in; then
    timeout 180 certbot --nginx -n --agree-tos $EM --cert-name ownfield.in -d ownfield.in -d www.ownfield.in && echo "domain-setup: cert ownfield.in + www" || echo "domain-setup: site certbot failed"
    reload
  fi
else echo "domain-setup: $SITE not pointing here yet"; fi
systemctl enable --now certbot.timer >/dev/null 2>&1 || echo "domain-setup: certbot.timer not available"
exit 0
