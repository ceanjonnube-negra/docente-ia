#!/usr/bin/env bash
# Pruebas de la migración 20261202000000 (Word y PDF por versión) en un
# PostgreSQL LOCAL: base de datos temporal, base mínima, migración, pruebas
# por rol y concurrencia real con dos sesiones. Nunca toca E2E ni Production.
#   TURNOS_PG="postgresql://postgres@127.0.0.1:54329" scripts/verificar-archivos-version-sql.sh
set -euo pipefail
SERVIDOR="${TURNOS_PG:-postgresql://postgres@127.0.0.1:54329}"
case "$SERVIDOR" in
  postgresql://*@127.0.0.1:*|postgresql://*@localhost:*) ;;
  *) echo "DETENIDO: solo se permite un PostgreSQL local (127.0.0.1/localhost)"; exit 1 ;;
esac
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
BASE="archivos_version_prueba_$$"
URL="$SERVIDOR/$BASE"
psql -X -q "$SERVIDOR/postgres" -c "create database $BASE" >/dev/null
trap 'psql -X -q "$SERVIDOR/postgres" -c "drop database if exists $BASE with (force)" >/dev/null' EXIT
psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$RAIZ/scripts/sql/base-supabase-turnos.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$RAIZ/scripts/sql/base-archivos-version.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$RAIZ/supabase/migrations/20261202000000_archivos_por_version.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$RAIZ/scripts/sql/verificar-archivos-version.sql" >/dev/null

# Concurrencia real: dos dispositivos piden el mismo formato de la misma versión a la vez.
A=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
V=e5000000-0000-4000-8000-000000000005
psql -X -q "$URL" -c "insert into public.planeacion_versiones (id, planeacion_id, docente_id, grupo_id, numero, contenido) values ('$V', 'da000000-0000-4000-8000-000000000001', '$A', 'a1000000-0000-4000-8000-000000000001', 5, 'texto v5')" >/dev/null
sesion() { psql -X -q -At "$URL" <<SQL
set role service_role;
begin;
select public.reservar_archivo_version('$A', '$V', 'word')->>'resultado';
select pg_sleep($1);
commit;
SQL
}
uno=$(mktemp); dos=$(mktemp)
sesion 2 >"$uno" & sleep 0.5; sesion 0 >"$dos"; wait
r1=$(grep -E '^[a-z_]+$' "$uno" | head -1); r2=$(grep -E '^[a-z_]+$' "$dos" | head -1)
psql -X -q "$URL" -c "insert into public.resultados (nombre, ok) values ('6a. Concurrencia real entre dispositivos: una reserva ($r1) y la otra espera y recibe en_proceso ($r2)', '$r1' = 'reservado' and '$r2' = 'en_proceso')" >/dev/null
: > "$uno"; : > "$dos"
psql -X -q -At "$URL" -c "select case when ok then '✓ ' else '✗ ' end || nombre from public.resultados order by n"
fallos=$(psql -X -q -At "$URL" -c "select count(*) from public.resultados where not ok")
total=$(psql -X -q -At "$URL" -c "select count(*) from public.resultados")
echo
if [ "$fallos" = "0" ]; then echo "Todas las pruebas pasaron ($total)."; else echo "$fallos prueba(s) fallaron."; exit 1; fi
