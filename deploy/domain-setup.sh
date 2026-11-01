#!/bin/bash
# Adds the custom domain(s) to the hosted nginx site (alongside the existing sslip.io name) and expands the existing
# Let's Encrypt cert to cover them. Idempotent; never fails the build. Called from server-hook.sh as root.
DOMAINS="ownfield.in www.ownfield.in"
command -v nginx >/dev/null && command -v certbot >/dev/null || { echo "domain-setup: nginx/certbot missing"; exit 0; }
IP=$(curl -s -m 5 https://checkip.amazonaws.com | tr -d '[:space:]')
for d in $DOMAINS; do
  r=$(getent ahostsv4 "$d" | awk 'NR==1{print $1}')
  [ -n "$IP" ] && [ "$r" = "$IP" ] || { echo "domain-setup: $d -> '$r' not this host ($IP), skipping"; exit 0; }
done
F=$(grep -lE 'server_name[^;]*sslip\.io' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null | head -1)
F=$(readlink -f "$F" 2>/dev/null)
[ -n "$F" ] || { echo "domain-setup: sslip nginx site not found"; exit 0; }
SSLIP=$(grep -oE '[a-z0-9.-]+\.sslip\.io' "$F" | head -1)
if ! grep -q 'ownfield\.in' "$F"; then
  cp "$F" /root/nginx-site.bak.$(date +%s)
  cp "$F" "$F.prev"
  sed -i -E "/server_name[^;]*sslip\.io/ s/;/ $DOMAINS;/" "$F"
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx; echo "domain-setup: server_name updated in $F"
  else mv "$F.prev" "$F"; echo "domain-setup: nginx -t failed, reverted"; exit 0; fi
  rm -f "$F.prev"
fi
# Cert: expand the sslip cert to all names (one cert, so the shared server block keeps serving every name).
CN=$(certbot certificates 2>/dev/null | awk -v s="$SSLIP" '/Certificate Name:/{n=$3} /Domains:/{ if (index($0,s)) {print n; exit} }')
HAVE=$(certbot certificates 2>/dev/null | awk -v n="$CN" '/Certificate Name:/{c=$3} /Domains:/{ if (c==n) print }')
NEED=0; for d in $DOMAINS; do echo " $HAVE " | grep -q " $d " || NEED=1; done
if [ "$NEED" = 1 ]; then
  ARGS="-d $SSLIP"; for d in $DOMAINS; do ARGS="$ARGS -d $d"; done
  [ -n "$CN" ] && ARGS="--cert-name $CN $ARGS"
  ls /etc/letsencrypt/accounts/*/directory/*/* >/dev/null 2>&1 || EM="--register-unsafely-without-email"
  timeout 180 certbot --nginx -n --agree-tos $EM --expand --redirect $ARGS && echo "domain-setup: cert issued for $SSLIP $DOMAINS" || echo "domain-setup: certbot failed"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
else echo "domain-setup: cert already covers $DOMAINS"; fi
systemctl enable --now certbot.timer >/dev/null 2>&1 || echo "domain-setup: certbot.timer not available (check cron renew)"
exit 0
