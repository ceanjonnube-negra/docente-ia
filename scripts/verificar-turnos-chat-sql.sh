#!/usr/bin/env bash
# Pruebas de la migración de turnos duraderos (20261129000000) en un
# PostgreSQL LOCAL: crea una base de datos temporal, aplica una base mínima
# tipo Supabase y la migración, corre las pruebas por rol y dos pruebas de
# concurrencia con sesiones simultáneas, y elimina la base al terminar.
# Nunca toca E2E ni Production: exige un servidor en 127.0.0.1/localhost.
#   TURNOS_PG="postgresql://postgres@127.0.0.1:54329" scripts/verificar-turnos-chat-sql.sh
set -euo pipefail
SERVIDOR="${TURNOS_PG:-postgresql://postgres@127.0.0.1:54329}"
case "$SERVIDOR" in
  postgresql://*@127.0.0.1:*|postgresql://*@localhost:*) ;;
  *) echo "DETENIDO: solo se permite un PostgreSQL local (127.0.0.1/localhost)"; exit 1 ;;
esac
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
BASE="turnos_prueba_$$"
URL="$SERVIDOR/$BASE"
psql -X -q "$SERVIDOR/postgres" -c "create database $BASE" >/dev/null
trap 'psql -X -q "$SERVIDOR/postgres" -c "drop database if exists $BASE with (force)" >/dev/null' EXIT

psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$RAIZ/scripts/sql/base-supabase-turnos.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$RAIZ/supabase/migrations/20261129000000_turnos_chat_duraderos.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$RAIZ/supabase/migrations/20261130000000_turnos_chat_tarjetas.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$RAIZ/supabase/migrations/20261201000000_turnos_chat_realtime.sql" >/dev/null
# Idempotente: aplicarla otra vez no falla ni duplica.
psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$RAIZ/supabase/migrations/20261201000000_turnos_chat_realtime.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$RAIZ/scripts/sql/verificar-turnos-chat.sql" >/dev/null

# Concurrencia real: la primera sesión adquiere y mantiene su transacción
# abierta; la segunda llega mientras tanto.
A=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
psql -X -q "$URL" -c "insert into public.conversaciones_chat (id, docente_id, grupo_id) values ('ca000000-0000-4000-8000-000000000005', '$A', 'a1000000-0000-4000-8000-000000000001'), ('ca000000-0000-4000-8000-000000000006', '$A', 'a1000000-0000-4000-8000-000000000001')" >/dev/null
sesion() { # $1 request_id, $2 conversación, $3 segundos de espera dentro de la transacción
  psql -X -q -At "$URL" <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub', '$A', false) \gset
begin;
select public.adquirir_turno_chat('$1', '$2', null, repeat('d', 64), 0::smallint, null, 210)->>'resultado';
select pg_sleep($3);
commit;
SQL
}
C3=ca000000-0000-4000-8000-000000000005
C4=ca000000-0000-4000-8000-000000000006
uno=$(mktemp); dos=$(mktemp); tres=$(mktemp); cuatro=$(mktemp)
sesion req-conc-0001 $C3 2 >"$uno" & sleep 0.5; sesion req-conc-0001 $C3 0 >"$dos"; wait
sesion req-conc-0002 $C4 2 >"$tres" & sleep 0.5; sesion req-conc-0003 $C4 0 >"$cuatro"; wait
r1=$(grep -E '^[a-z_]+$' "$uno" | head -1); r2=$(grep -E '^[a-z_]+$' "$dos" | head -1)
r3=$(grep -E '^[a-z_]+$' "$tres" | head -1); r4=$(grep -E '^[a-z_]+$' "$cuatro" | head -1)
filas=$(psql -X -q -At "$URL" -c "select count(*) from public.turnos_chat where request_id = 'req-conc-0001'")
psql -X -q "$URL" -c "insert into public.resultados (nombre, ok) values
  ('7a. Concurrencia, el mismo envío desde dos sesiones: una ejecuta ($r1) y la otra espera y recibe en_proceso ($r2); una sola fila', '$r1' = 'adquirido' and '$r2' = 'en_proceso' and $filas = 1),
  ('7b. Concurrencia, dos mensajes distintos en la misma conversación: uno ejecuta ($r3) y el otro recibe ocupada ($r4)', '$r3' = 'adquirido' and '$r4' = 'ocupada')" >/dev/null
for f in "$uno" "$dos" "$tres" "$cuatro"; do : > "$f"; done

psql -X -q -At "$URL" -c "select case when ok then '✓ ' else '✗ ' end || nombre from public.resultados order by n"
fallos=$(psql -X -q -At "$URL" -c "select count(*) from public.resultados where not ok")
total=$(psql -X -q -At "$URL" -c "select count(*) from public.resultados")
echo
if [ "$fallos" = "0" ]; then echo "Todas las pruebas pasaron ($total)."; else echo "$fallos prueba(s) fallaron."; exit 1; fi
