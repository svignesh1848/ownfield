#!/bin/bash
# Custom domains on the hosted nginx (called from server-hook.sh as root). Idempotent; never fails the build.
#  - app.ownfield.in: served by the existing app site, next to the sslip.io name (one expanded Let's Encrypt cert).
#  - ownfield.in, www.ownfield.in: own cert; company website from website/ on www, apex 301 -> www.
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
# 2) apex + www: company website (repo website/), copied to /var/www/ownfield-site; www is canonical, apex -> www
ok=1; for d in $SITE; do here "$d" || ok=0; done
WEB=$(cd "$(dirname "$0")/.." && pwd)/website; ROOT=/var/www/ownfield-site
if [ $ok = 1 ] && [ -f "$WEB/index.html" ]; then
  mkdir -p $ROOT.new && cp -a "$WEB/." $ROOT.new/ && chmod -R a+rX $ROOT.new
  rm -rf $ROOT.old; [ -d $ROOT ] && mv $ROOT $ROOT.old; mv $ROOT.new $ROOT; rm -rf $ROOT.old
  R=/etc/nginx/sites-available/ownfield-site; L=/etc/letsencrypt/live/ownfield.in
  LOC='  root /var/www/ownfield-site;\n  index index.html;\n  location / { try_files $uri $uri/ =404; }\n  location ~* \\.(png|svg|ico|css|webp|jpg)$ { expires 7d; add_header Cache-Control "public"; }\n  error_page 404 /index.html;\n  gzip on; gzip_types text/css application/javascript image/svg+xml application/xml;\n'
  ACME='  location /.well-known/acme-challenge/ { root /var/www/html; }\n'
  if [ -f $L/fullchain.pem ] && covers ownfield.in www.ownfield.in; then
    OPT=""; [ -f /etc/letsencrypt/options-ssl-nginx.conf ] && OPT='  include /etc/letsencrypt/options-ssl-nginx.conf;\n'
    [ -f /etc/letsencrypt/ssl-dhparams.pem ] && OPT="$OPT"'  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n'
    TLS="  listen 443 ssl;\n  listen [::]:443 ssl;\n  ssl_certificate $L/fullchain.pem;\n  ssl_certificate_key $L/privkey.pem;\n$OPT"
    printf "# managed by deploy/domain-setup.sh\nserver {\n  listen 80;\n  listen [::]:80;\n  server_name $SITE;\n$ACME  location / { return 301 https://www.ownfield.in\$request_uri; }\n}\nserver {\n$TLS  server_name ownfield.in;\n  return 301 https://www.ownfield.in\$request_uri;\n}\nserver {\n$TLS  server_name www.ownfield.in;\n  add_header X-Content-Type-Options nosniff;\n$LOC}\n" >$R.new
    NEEDCERT=0
  else
    printf "# managed by deploy/domain-setup.sh (http only until cert)\nserver {\n  listen 80;\n  listen [::]:80;\n  server_name $SITE;\n$ACME$LOC}\n" >$R.new
    NEEDCERT=1
  fi
  if [ -f $R ] && cmp -s $R.new $R; then rm -f $R.new; else
    [ -f $R ] && cp $R $R.prev; mv $R.new $R; ln -sf $R /etc/nginx/sites-enabled/ownfield-site
    if reload; then echo "domain-setup: website config updated"; rm -f $R.prev
    elif [ -f $R.prev ]; then mv $R.prev $R; reload; echo "domain-setup: website config invalid, reverted"
    else rm -f /etc/nginx/sites-enabled/ownfield-site $R; reload; echo "domain-setup: website config invalid, removed"; fi
  fi
  if [ "$NEEDCERT" = 1 ]; then
    timeout 180 certbot certonly --webroot -w /var/www/html -n --agree-tos $EM --cert-name ownfield.in -d ownfield.in -d www.ownfield.in && echo "domain-setup: cert ownfield.in + www (rerun to enable https)" || echo "domain-setup: site certbot failed"
  fi
else echo "domain-setup: $SITE not pointing here yet (or website/ missing)"; fi
systemctl enable --now certbot.timer >/dev/null 2>&1 || echo "domain-setup: certbot.timer not available"
exit 0
