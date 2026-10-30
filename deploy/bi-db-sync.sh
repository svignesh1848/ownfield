#!/bin/bash
# Keeps PostgreSQL's outside access for BI tools in line with the app (runs as root every 2 min).
# Off (BI_DB_EXPOSE!=1, the default): Postgres listens on localhost only and no outside rule exists.
# On: listen on all interfaces, TLS on (Let's Encrypt cert of this host when present), and one
#   "hostssl <db> ff_bi_c<id> <ip> scram-sha-256" line per allow-listed IP of each company whose BI login is enabled.
# Writes /var/lib/fieldforce-oss-bi/status.json (no secrets) so the app can show the status.
set -u
. /etc/fieldforce-oss-options.env 2>/dev/null
EXPOSE=${BI_DB_EXPOSE:-0}; PORT=${BI_DB_PORT:-5432}; APPDB=${APPDB:-ffoss}
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || PORT=5432
[[ "$APPDB" =~ ^[a-z_][a-z0-9_]*$ ]] || exit 1
PSQL="sudo -u postgres psql -qAtX"
HBA=$($PSQL -c 'show hba_file'); CONFD=$(dirname "$($PSQL -c 'show config_file')")/conf.d
[ -f "$HBA" ] && [ -d "$CONFD" ] || exit 1
ST=/var/lib/fieldforce-oss-bi; mkdir -p $ST; chmod 755 $ST
CONF=$CONFD/ff-bi.conf; B='# BEGIN fieldforce-oss BI'; E='# END fieldforce-oss BI'
lines=""; TLS=no; HOST=$(ls /etc/letsencrypt/live 2>/dev/null | grep -v README | head -1)
if [ "$EXPOSE" = 1 ]; then
  while IFS='|' read -r role ip; do
    [[ "$role" =~ ^ff_bi_c[0-9]+$ ]] || continue
    if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/(1[6-9]|2[0-9]|3[0-2])$ ]] || [[ "$ip" =~ ^[0-9a-f:]+/(4[89]|[5-9][0-9]|1[01][0-9]|12[0-8])$ ]]; then
      lines+="hostssl $APPDB $role $ip scram-sha-256"$'\n'
    fi
  done < <($PSQL -d "$APPDB" -c "SELECT 'ff_bi_c'||kv.company_id, ip FROM company_kv kv JOIN pg_roles r ON r.rolname='ff_bi_c'||kv.company_id AND r.rolcanlogin
      CROSS JOIN LATERAL json_array_elements_text(CASE WHEN json_typeof(kv.v::json->'ips')='array' THEN kv.v::json->'ips' ELSE '[]'::json END) ip WHERE kv.k='workspace_bi'" 2>/dev/null)
  # TLS with the host's trusted certificate (needed by Power BI / Tableau with certificate checks); falls back to the distro's.
  if [ -n "$HOST" ] && [ -s /etc/letsencrypt/live/$HOST/fullchain.pem ]; then
    K=/var/lib/postgresql/ff-ssl; mkdir -p $K
    cp -L /etc/letsencrypt/live/$HOST/fullchain.pem $K/server.crt.new; cp -L /etc/letsencrypt/live/$HOST/privkey.pem $K/server.key.new
    chown -R postgres:postgres $K; chmod 700 $K; chmod 600 $K/*.new
    cmp -s $K/server.crt.new $K/server.crt || { mv $K/server.crt.new $K/server.crt; mv $K/server.key.new $K/server.key; }; rm -f $K/*.new
    want="listen_addresses = '*'"$'\n'"port = $PORT"$'\n'"ssl = on"$'\n'"ssl_cert_file = '$K/server.crt'"$'\n'"ssl_key_file = '$K/server.key'"$'\n'"ssl_min_protocol_version = 'TLSv1.2'"$'\n'"password_encryption = 'scram-sha-256'"
  else
    want="listen_addresses = '*'"$'\n'"port = $PORT"$'\n'"ssl = on"$'\n'"ssl_min_protocol_version = 'TLSv1.2'"$'\n'"password_encryption = 'scram-sha-256'"
  fi
  TLS=yes
fi
# pg_hba managed block
tmp=$(mktemp); sed "/^$B\$/,/^$E\$/d" "$HBA" >"$tmp"
[ -n "$lines" ] && printf '%s\n%s%s\n' "$B" "$lines" "$E" >>"$tmp"
reload=no restart=no
cmp -s "$tmp" "$HBA" || { cat "$tmp" >"$HBA"; reload=yes; }; rm -f "$tmp"
# listening: only when there is at least one allowed address
if [ "$EXPOSE" = 1 ] && [ -n "$lines" ]; then
  [ "$(cat $CONF 2>/dev/null)" = "$want" ] || { old_listen=$(grep -s listen_addresses $CONF); printf '%s\n' "$want" >$CONF; chown postgres:postgres $CONF
    [ "$old_listen" = "listen_addresses = '*'" ] && reload=yes || restart=yes; }
elif [ -f $CONF ]; then rm -f $CONF; restart=yes; fi
if [ $restart = yes ]; then systemctl restart postgresql; echo "$(date -Is) bi-sync: postgres restarted (expose=$EXPOSE)"
elif [ $reload = yes ]; then systemctl reload postgresql; echo "$(date -Is) bi-sync: rules reloaded"; fi
n=$(printf '%s' "$lines" | grep -c . || true)
if [ "$EXPOSE" = 1 ] && [ -n "$lines" ]; then ex=true; else ex=false; fi
printf '{"exposed":%s,"tls":%s,"host":"%s","port":%s,"rules":%s,"at":"%s"}\n' "$ex" "$([ $TLS = yes ] && echo true || echo false)" "${HOST:-}" "$PORT" "${n:-0}" "$(date -Is)" >$ST/status.json.new
chmod 644 $ST/status.json.new; mv $ST/status.json.new $ST/status.json
