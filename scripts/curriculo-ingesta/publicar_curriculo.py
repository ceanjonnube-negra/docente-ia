#!/usr/bin/env python3
"""Publicación canónica — Currículo V1-B-4B.

staging (ingesta_curricular_candidato, estado='completado')
  -> revalidación completa (en esta misma corrida, nunca se confía en una
     validación previa)
  -> publicación PostgreSQL transaccional (BEGIN...COMMIT, una sola sesión)
  -> read-back canónico externo
  -> validación de invariantes

NUNCA publica directamente desde un PDF — exige una ingesta ya
`completado` en staging. NO usa IA. NO usa OCR. NO inserta
curriculo_eje_articulador (fuera de alcance de esta fuente).

Reutiliza de cargar_staging.py (V1-B-3, sin modificarlo): `_ejecutar_sql_archivo`,
`_dq` (dollar-quoting seguro), `RAIZ_PROYECTO`, `ErrorEjecucionSQL`.

Mecanismo transaccional — verificado empíricamente esta ronda con datos
descartables (creados y revertidos con ROLLBACK real, confirmado desde una
consulta externa):

  1. Un archivo `BEGIN; ...; COMMIT;` ejecutado en una sola invocación de
     `supabase db query --linked --file` SÍ comparte una única sesión/
     transacción real de PostgreSQL — confirmado (un INSERT fue visible a
     un SELECT posterior en el mismo archivo; tras ROLLBACK, una consulta
     externa separada confirmó 0 filas).
  2. Sentencias SEPARADAS (no forzadas a un único "statement" con CTEs)
     comparten la transacción sin el problema encontrado en V1-B-3B
     (un UPDATE como statement primario de un WITH que ya modificó la
     MISMA tabla vía CTE no aplicaba su SET). Aquí cada INSERT real va a
     una tabla distinta de la que cualquier CTE tocó en esa misma
     sentencia — patrón seguro.
  3. Para pasar IDs resueltos/creados entre sentencias separadas de la
     MISMA transacción (p. ej. el id de fuente_oficial recién creado,
     necesario en sentencias posteriores) se usa una tabla TEMPORAL de
     sesión (`create temporary table ... on commit drop`) como puente —
     verificado empíricamente que funciona correctamente (un id guardado
     en la tabla puente coincidió exactamente con el id real de la fila
     creada, confirmado en el mismo archivo).
  4. SCOPE_YA_PUBLICADO / guardas de "existe más de uno" / validación de
     invariantes pre-COMMIT se implementan con aborto condicional SQL
     nativo: `1 / (case when <condición> then 0 else 1 end)`.
     IMPORTANTE — hallazgo real durante esta ronda, no asumido: la
     variante inicialmente diseñada en V1-B-4A, `case when <condición>
     then '<ETIQUETA>'::integer else 1 end` (para obtener un mensaje de
     error legible), **resultó defectuosa** — verificado empíricamente
     que PostgreSQL evalúa el cast de un literal de texto a tipo en
     tiempo de PARSEO (vía la función de entrada del tipo), no en tiempo
     de ejecución del CASE, así que el error se dispara SIEMPRE, sin
     importar la condición real (confirmado: `case when false then
     'x'::integer else 1 end` falla igual que con `true`). También se
     confirmó que `1/0` con operandos puramente literales se pliega en
     tiempo de planificación de la misma forma, independientemente de la
     condición — el diseño original de V1-B-4A solo se había probado con
     la rama verdadera, nunca con la falsa. La forma robusta y verificada
     en ambas ramas es dividir entre un CASE cuyo resultado depende de
     una subconsulta real (no de literales puros): PostgreSQL no puede
     plegarlo en tiempo de planificación, así que el error de
     división-por-cero solo ocurre genuinamente cuando la condición real
     se cumple en tiempo de ejecución (confirmado con datos reales:
     condición falsa → `1`, sin error; condición verdadera → error real).
     El costo de este cambio es perder el mensaje personalizado embebido
     — se compensa con diagnóstico post-fallo en Python (ver
     `_diagnosticar_fallo`), que vuelve a consultar el estado real
     después de un error para reportar la causa probable.
  5. `pg_advisory_xact_lock` se adquiere al inicio, se libera solo al
     COMMIT/ROLLBACK — verificado que funciona dentro de este mecanismo.

Uso:
    ./.venv/bin/python3 publicar_curriculo.py --ingesta-id <uuid>
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict

from cargar_staging import ErrorEjecucionSQL, RAIZ_PROYECTO, _dq, _ejecutar_sql_archivo

CLAVE_ADVISORY_LOCK = "curriculo_publicacion_v1"

FUENTE_HASH_FASE4_CONOCIDA = "36e0c3cdbc3221cdf9c4b9f3ec9e889f98060249fc0ab1ddecd419b28bcbe734"
FUENTE_URL_FASE4_CONOCIDA = "https://educacionbasica.sep.gob.mx/wp-content/uploads/2024/06/Programa_Sintetico_Fase_4.pdf"
FUENTE_ORGANISMO = "SEP"
FUENTE_TITULO = "Programa de Estudio para la Educación Primaria: Programa Sintético de la Fase 4"
FUENTE_VERSION_EDICION = "Primera edición, 2024"
FUENTE_TIPO_DOCUMENTO = "programa_sintetico"

VERSION_NOMBRE = "Programa de Estudio para la Educación Primaria: Programa Sintético de la Fase 4"

FASE_NIVEL_EDUCATIVO = "primaria"
FASE_CLAVE = "fase_4"
FASE_NOMBRE = "Fase 4"

GRADOS_CONOCIDOS = [
    {"clave": "3", "nombre": "Tercer grado", "orden": 3},
    {"clave": "4", "nombre": "Cuarto grado", "orden": 4},
]

INVARIANTES_STAGING_CONOCIDOS = {
    "campo": 4,
    "contenido": 85,
    "pda": 487,
    "pda_grado": 487,
}
PDA_GRADO_3_ESPERADOS = 246
PDA_GRADO_4_ESPERADOS = 241


class ErrorValidacionPublicacion(Exception):
    pass


# ========== LECTURA DE STAGING ==========

def construir_sql_leer_ingesta(ingesta_id: str) -> str:
    return f"""
select id, estado, fuente_hash, perfil_extractor, version_pipeline, scope_hash, scope_solicitado
from public.ingesta_curricular
where id = {_dq(ingesta_id, 'iid')};
""".strip()


def construir_sql_leer_candidatos_completos(ingesta_id: str) -> str:
    return f"""
select tipo, clave_local, parent_local, payload, evidencia, fingerprint, estado_validacion
from public.ingesta_curricular_candidato
where ingesta_id = {_dq(ingesta_id, 'iid')}
order by tipo, clave_local;
""".strip()


def leer_staging(ingesta_id: str) -> tuple[dict, list[dict]]:
    r_ingesta = _ejecutar_sql_archivo(construir_sql_leer_ingesta(ingesta_id))
    filas = r_ingesta.get("rows", [])
    if len(filas) != 1:
        raise ErrorValidacionPublicacion([f"ingesta {ingesta_id}: se esperaba exactamente 1 fila, se encontraron {len(filas)}"])
    ingesta = filas[0]

    r_candidatos = _ejecutar_sql_archivo(construir_sql_leer_candidatos_completos(ingesta_id))
    candidatos = r_candidatos.get("rows", [])
    return ingesta, candidatos


# ========== REVALIDACIÓN (esta misma corrida, nunca se confía en staging previo) ==========

def revalidar_staging(ingesta: dict, candidatos: list[dict]) -> dict:
    problemas: list[str] = []

    if ingesta.get("estado") != "completado":
        problemas.append(f"ingesta.estado={ingesta.get('estado')!r} (se requiere 'completado')")
    if ingesta.get("fuente_hash") != FUENTE_HASH_FASE4_CONOCIDA:
        problemas.append(f"fuente_hash inesperado: {ingesta.get('fuente_hash')!r}")

    total = len(candidatos)
    if total != 1063:
        problemas.append(f"total candidatos={total} (esperado 1063)")

    por_tipo = Counter(c["tipo"] for c in candidatos)
    for tipo, esperado in INVARIANTES_STAGING_CONOCIDOS.items():
        if por_tipo.get(tipo, 0) != esperado:
            problemas.append(f"candidatos tipo={tipo}: {por_tipo.get(tipo, 0)} (esperado {esperado})")

    dudosos = [c for c in candidatos if c["estado_validacion"] == "dudoso"]
    if dudosos:
        problemas.append(f"{len(dudosos)} candidatos en estado dudoso")

    claves = [c["clave_local"] for c in candidatos]
    duplicadas = [k for k, n in Counter(claves).items() if n > 1]
    if duplicadas:
        problemas.append(f"clave_local duplicada: {duplicadas[:5]}")

    claves_set = set(claves)
    huerfanos = [c["clave_local"] for c in candidatos if c["parent_local"] is not None and c["parent_local"] not in claves_set]
    if huerfanos:
        problemas.append(f"{len(huerfanos)} candidatos con parent_local inexistente: {huerfanos[:5]}")

    pdas = {c["clave_local"] for c in candidatos if c["tipo"] == "pda"}
    pdas_con_grado = defaultdict(list)
    for c in candidatos:
        if c["tipo"] == "pda_grado":
            pdas_con_grado[c["parent_local"]].append(c["payload"].get("grado_clave"))
    sin_grado = pdas - set(pdas_con_grado)
    if sin_grado:
        problemas.append(f"{len(sin_grado)} PDA sin ninguna relación pda_grado")

    conteo_grado3 = sum(1 for c in candidatos if c["tipo"] == "pda_grado" and c["payload"].get("grado_clave") == "3")
    conteo_grado4 = sum(1 for c in candidatos if c["tipo"] == "pda_grado" and c["payload"].get("grado_clave") == "4")
    if conteo_grado3 != PDA_GRADO_3_ESPERADOS:
        problemas.append(f"pda_grado grado=3: {conteo_grado3} (esperado {PDA_GRADO_3_ESPERADOS})")
    if conteo_grado4 != PDA_GRADO_4_ESPERADOS:
        problemas.append(f"pda_grado grado=4: {conteo_grado4} (esperado {PDA_GRADO_4_ESPERADOS})")

    for c in candidatos:
        if not c.get("fingerprint") or not isinstance(c["fingerprint"], str) or len(c["fingerprint"]) < 16:
            problemas.append(f"fingerprint estructuralmente inválido en {c['clave_local']}: {c.get('fingerprint')!r}")
            break  # uno solo basta para reportar el problema; no inundar la lista

    if problemas:
        raise ErrorValidacionPublicacion(problemas)

    return {"ok": True, "total_candidatos": total, "por_tipo": dict(por_tipo)}


# ========== RECONSTRUCCIÓN DE FRAGMENTOS (evidencia de staging -> fragmento canónico) ==========

def construir_fragmentos(candidatos: list[dict]) -> list[dict]:
    """1 fragmento por página real citada en la evidencia de contenido/pda
    (ver diseño V1-B-4A, confirmado: 39 páginas). El texto se reconstruye
    concatenando, en orden de posición vertical real (top), el
    texto_original YA extraído — nunca se corrige, resume, ni genera con
    IA. `seccion` = nombre del campo formativo al que pertenecen los
    elementos de esa página (consistente por construcción: cada página
    pertenece a un único campo, dado que los rangos de página por campo
    no se solapan)."""
    campos = {c["clave_local"]: c["payload"]["nombre"] for c in candidatos if c["tipo"] == "campo"}
    campo_de_contenido = {c["clave_local"]: c["parent_local"] for c in candidatos if c["tipo"] == "contenido"}

    por_pagina = defaultdict(list)  # pagina -> [(top, texto_original, campo_clave_local)]

    for c in candidatos:
        if c["tipo"] == "contenido":
            ev = c["evidencia"]
            por_pagina[ev["pagina"]].append((ev["top"], ev["texto_original"], campo_de_contenido[c["clave_local"]]))
        elif c["tipo"] == "pda":
            ev = c["evidencia"]
            contenido_clave = c["parent_local"]
            por_pagina[ev["pagina"]].append((ev["top"], ev["texto_original"], campo_de_contenido[contenido_clave]))

    fragmentos = []
    for pagina in sorted(por_pagina.keys()):
        elementos = sorted(por_pagina[pagina], key=lambda e: e[0])
        texto = "\n".join(e[1] for e in elementos)
        campos_de_pagina = {e[2] for e in elementos}
        # Invariante esperada (no forzada): cada página pertenece a un
        # único campo. Si alguna vez no fuera así, se reporta como
        # anomalía explícita en vez de adivinar cuál usar.
        if len(campos_de_pagina) == 1:
            campo_clave_local = next(iter(campos_de_pagina))
            seccion = campos[campo_clave_local]
        else:
            seccion = None  # anomalía real -- ver validación de fragmentos en publicar()
        fragmentos.append({
            "pagina": pagina,
            "orden": pagina,
            "seccion": seccion,
            "texto": texto,
            "campos_de_pagina": sorted(campos_de_pagina),
        })
    return fragmentos


# ========== CONSTRUCCIÓN DEL SQL DE PUBLICACIÓN ==========

def construir_sql_publicacion(candidatos: list[dict], fragmentos: list[dict]) -> str:
    campos = [c for c in candidatos if c["tipo"] == "campo"]
    contenidos = [c for c in candidatos if c["tipo"] == "contenido"]
    pdas = [c for c in candidatos if c["tipo"] == "pda"]
    pda_grados = [c for c in candidatos if c["tipo"] == "pda_grado"]

    campos_json = json.dumps([{"clave_local": c["clave_local"], "clave": c["payload"]["clave"], "nombre": c["payload"]["nombre"]} for c in campos], ensure_ascii=False)

    fragmentos_json = json.dumps([{"pagina": f["pagina"], "orden": f["orden"], "seccion": f["seccion"] or "", "texto": f["texto"]} for f in fragmentos], ensure_ascii=False)

    contenidos_json = json.dumps([
        {
            "clave_local": c["clave_local"],
            "campo_clave_local": c["parent_local"],
            "titulo": c["payload"]["titulo"],
            "pagina": c["evidencia"]["pagina"],
        }
        for c in contenidos
    ], ensure_ascii=False)

    pdas_json = json.dumps([
        {
            "clave_local": p["clave_local"],
            "contenido_clave_local": p["parent_local"],
            "texto": p["payload"]["texto"],
            "pagina": p["evidencia"]["pagina"],
        }
        for p in pdas
    ], ensure_ascii=False)

    pda_grados_json = json.dumps([
        {
            "clave_local": pg["clave_local"],
            "pda_clave_local": pg["parent_local"],
            "grado_clave": pg["payload"]["grado_clave"],
        }
        for pg in pda_grados
    ], ensure_ascii=False)

    grados_json = json.dumps(GRADOS_CONOCIDOS, ensure_ascii=False)

    return f"""
begin;

-- Advisory lock: serializa cualquier publicación curricular concurrente
-- (clave estable y documentada, compartida por todo el proceso de
-- publicación — no por scope). Se libera automáticamente al COMMIT/ROLLBACK.
select pg_advisory_xact_lock(hashtext({_dq(CLAVE_ADVISORY_LOCK, 'lockkey')}));

-- Tabla puente de esta transacción únicamente (nunca persiste) para pasar
-- ids resueltos/creados entre sentencias separadas de la misma sesión.
create temporary table _pub_ids (clave text primary key, id uuid not null) on commit drop;

-- ===== 1) FUENTE_OFICIAL: resolver o crear, por hash_archivo =====
with existentes as (
  select id from public.fuente_oficial where hash_archivo = {_dq(FUENTE_HASH_FASE4_CONOCIDA, 'fh')}
),
guardia_multiples as (
  -- FUENTE_OFICIAL_AMBIGUA si dispara division-by-zero real (el
  -- denominador depende de datos reales -- ver nota de cabecera sobre
  -- por qué NO se usa un cast de texto literal aquí: PostgreSQL evalúa
  -- casts de literales de texto en tiempo de PARSEO, antes de que el
  -- CASE decida su rama, y dispara el error siempre, sin importar la
  -- condición real -- confirmado empíricamente).
  select 1 / (case when (select count(*) from existentes) > 1 then 0 else 1 end) as ok
),
insertado as (
  insert into public.fuente_oficial (organismo, titulo, tipo_documento, version_edicion, url_fuente, hash_archivo, estado, metadata)
  select {_dq(FUENTE_ORGANISMO, 'org')}, {_dq(FUENTE_TITULO, 'tit')}, {_dq(FUENTE_TIPO_DOCUMENTO, 'td')}, {_dq(FUENTE_VERSION_EDICION, 've')}, {_dq(FUENTE_URL_FASE4_CONOCIDA, 'url')}, {_dq(FUENTE_HASH_FASE4_CONOCIDA, 'fh2')}, 'borrador', '{{}}'::jsonb
  where (select ok from guardia_multiples) = 1 and not exists (select 1 from existentes)
  returning id
)
insert into _pub_ids (clave, id)
select 'fuente_oficial', coalesce((select id from existentes), (select id from insertado));

-- ===== 2) CURRICULO_VERSION: resolver o crear, por fuente_oficial_id =====
with fid as (
  select id from _pub_ids where clave = 'fuente_oficial'
),
existentes as (
  select id from public.curriculo_version where fuente_oficial_id = (select id from fid)
),
guardia_multiples as (
  -- VERSION_AMBIGUA si dispara division-by-zero real.
  select 1 / (case when (select count(*) from existentes) > 1 then 0 else 1 end) as ok
),
insertado as (
  insert into public.curriculo_version (organismo, nombre, acuerdo_oficial, fuente_oficial_id, estado)
  select {_dq(FUENTE_ORGANISMO, 'org2')}, {_dq(VERSION_NOMBRE, 'vn')}, null, (select id from fid), 'borrador'
  where (select ok from guardia_multiples) = 1 and not exists (select 1 from existentes)
  returning id
)
insert into _pub_ids (clave, id)
select 'version', coalesce((select id from existentes), (select id from insertado));

-- ===== 3) CURRICULO_GRADO: catálogo global, resolver o crear (UNIQUE real) =====
with candidatos_grado as (
  select * from jsonb_to_recordset({_dq(grados_json, 'gj')}::jsonb) as x(clave text, nombre text, orden int)
),
insertados as (
  insert into public.curriculo_grado (nivel_educativo, clave, nombre, orden)
  select {_dq(FASE_NIVEL_EDUCATIVO, 'ne1')}, cg.clave, cg.nombre, cg.orden
  from candidatos_grado cg
  where not exists (
    select 1 from public.curriculo_grado g
    where g.nivel_educativo = {_dq(FASE_NIVEL_EDUCATIVO, 'ne2')} and g.clave = cg.clave
  )
  returning id, clave
)
insert into _pub_ids (clave, id)
select 'grado:' || coalesce(i.clave, e.clave), coalesce(i.id, e.id)
from candidatos_grado cg
left join insertados i on i.clave = cg.clave
left join public.curriculo_grado e on e.nivel_educativo = {_dq(FASE_NIVEL_EDUCATIVO, 'ne3')} and e.clave = cg.clave and i.id is null;

-- ===== 4) CURRICULO_FASE: Fase 4 de esta versión, resolver o crear =====
with vid as (select id from _pub_ids where clave = 'version'),
existentes as (
  select id from public.curriculo_fase
  where curriculo_version_id = (select id from vid) and nivel_educativo = {_dq(FASE_NIVEL_EDUCATIVO, 'ne4')} and clave = {_dq(FASE_CLAVE, 'fc1')}
),
guardia_multiples as (
  -- FASE_AMBIGUA si dispara division-by-zero real.
  select 1 / (case when (select count(*) from existentes) > 1 then 0 else 1 end) as ok
),
insertado as (
  insert into public.curriculo_fase (curriculo_version_id, nivel_educativo, clave, nombre)
  select (select id from vid), {_dq(FASE_NIVEL_EDUCATIVO, 'ne5')}, {_dq(FASE_CLAVE, 'fc2')}, {_dq(FASE_NOMBRE, 'fn')}
  where (select ok from guardia_multiples) = 1 and not exists (select 1 from existentes)
  returning id
)
insert into _pub_ids (clave, id)
select 'fase', coalesce((select id from existentes), (select id from insertado));

-- ===== 5) CURRICULO_FASE_GRADO: Fase 4 x {{3°,4°}} (UNIQUE real -> ON CONFLICT DO NOTHING) =====
with fase as (select id from _pub_ids where clave='fase'),
grado3 as (select id from _pub_ids where clave='grado:3'),
grado4 as (select id from _pub_ids where clave='grado:4')
insert into public.curriculo_fase_grado (curriculo_fase_id, curriculo_grado_id, nivel_educativo)
select (select id from fase), g.id, {_dq(FASE_NIVEL_EDUCATIVO, 'ne6')}
from (select id from grado3 union all select id from grado4) g
on conflict (curriculo_fase_id, curriculo_grado_id) do nothing;

-- ===== 6) CURRICULO_CAMPO_FORMATIVO: los 4 campos reales de staging =====
with vid as (select id from _pub_ids where clave = 'version'),
candidatos_campo as (
  select * from jsonb_to_recordset({_dq(campos_json, 'cj')}::jsonb) as x(clave_local text, clave text, nombre text)
),
insertados as (
  insert into public.curriculo_campo_formativo (curriculo_version_id, clave, nombre)
  select (select id from vid), cc.clave, cc.nombre
  from candidatos_campo cc
  where not exists (
    select 1 from public.curriculo_campo_formativo cf
    where cf.curriculo_version_id = (select id from vid) and cf.clave = cc.clave
  )
  returning id, clave
)
insert into _pub_ids (clave, id)
select cc.clave_local, coalesce(i.id, e.id)
from candidatos_campo cc
left join insertados i on i.clave = cc.clave
left join public.curriculo_campo_formativo e
  on e.curriculo_version_id = (select id from vid) and e.clave = cc.clave and i.id is null;

-- ===== 7) SCOPE_YA_PUBLICADO: comprobar las 8 combinaciones exactas ANTES de tocar contenido/PDA =====
-- (fase/grados/campos ya resueltos arriba son catálogo — su existencia
-- por sí sola no implica "contenido publicado"; si este chequeo aborta,
-- el ROLLBACK revierte también cualquier fase/campo recién creados aquí.)
with vid as (select id from _pub_ids where clave='version'),
fid as (select id from _pub_ids where clave='fase'),
grados as (
  select id from _pub_ids where clave in ('grado:3','grado:4')
),
campos_ids as (
  select id from _pub_ids where clave in ({", ".join(_dq(c["clave_local"], f"cid{i}") for i, c in enumerate(campos))})
),
combinaciones_objetivo as (
  select (select id from vid) as version_id, (select id from fid) as fase_id, g.id as grado_id, c.id as campo_id
  from grados g cross join campos_ids c
),
ya_publicado as (
  select count(*) as n
  from combinaciones_objetivo co
  join public.curriculo_cobertura cc
    on cc.curriculo_version_id = co.version_id and cc.fase_id = co.fase_id
   and cc.grado_id = co.grado_id and cc.campo_formativo_id = co.campo_id
)
-- SCOPE_YA_PUBLICADO si dispara division-by-zero real.
select 1 / (case when (select n from ya_publicado) > 0 then 0 else 1 end) as ok;

-- ===== 8) FUENTE_OFICIAL_FRAGMENTO: 39 filas, una por página =====
with fid as (select id from _pub_ids where clave = 'fuente_oficial'),
candidatos_frag as (
  select * from jsonb_to_recordset({_dq(fragmentos_json, 'frj')}::jsonb) as x(pagina int, orden int, seccion text, texto text)
),
insertados as (
  insert into public.fuente_oficial_fragmento (fuente_oficial_id, pagina, seccion, texto, orden)
  select (select id from fid), cf.pagina, cf.seccion, cf.texto, cf.orden
  from candidatos_frag cf
  returning id, pagina
)
insert into _pub_ids (clave, id)
select 'fragmento:' || pagina, id from insertados;

-- ===== 9) CURRICULO_CONTENIDO: 85 filas =====
-- clave_oficial se usa TEMPORALMENTE para acarrear la clave_local de
-- staging a través de RETURNING (identidad inyectiva garantizada por el
-- UNIQUE(ingesta_id, clave_local) de staging, ya revalidado) -- NUNCA se
-- deja así: el paso 9b la limpia a NULL antes del COMMIT (V1-A exige
-- clave_oficial nullable, nunca una clave inventada). Este método es
-- robusto incluso ante los 5 casos reales de PDA con texto idéntico
-- entre grados dentro del mismo contenido (ver V1-B-4A §13) — un
-- emparejamiento por contenido: texto habría sido ambiguo en esos casos.
with vid as (select id from _pub_ids where clave='version'),
fase as (select id from _pub_ids where clave='fase'),
candidatos_contenido as (
  select * from jsonb_to_recordset({_dq(contenidos_json, 'ctj')}::jsonb) as x(clave_local text, campo_clave_local text, titulo text, pagina int)
),
insertados as (
  insert into public.curriculo_contenido (curriculo_version_id, fase_id, campo_formativo_id, clave_oficial, titulo, fuente_oficial_fragmento_id)
  select
    (select id from vid),
    (select id from fase),
    (select pi.id from _pub_ids pi where pi.clave = cc.campo_clave_local),
    cc.clave_local,
    cc.titulo,
    (select pi.id from _pub_ids pi where pi.clave = 'fragmento:' || cc.pagina)
  from candidatos_contenido cc
  returning id, clave_oficial as clave_local_temporal
)
insert into _pub_ids (clave, id)
select clave_local_temporal, id from insertados;

-- 9b) limpieza: clave_oficial vuelve a NULL (nunca se presupone clave SEP)
update public.curriculo_contenido
set clave_oficial = null
where curriculo_version_id = (select id from _pub_ids where clave='version');

-- ===== 10) CURRICULO_PDA: 487 filas ===== (mismo método que el paso 9)
with vid as (select id from _pub_ids where clave='version'),
candidatos_pda as (
  select * from jsonb_to_recordset({_dq(pdas_json, 'pdj')}::jsonb) as x(clave_local text, contenido_clave_local text, texto text, pagina int)
),
insertados as (
  insert into public.curriculo_pda (curriculo_version_id, contenido_id, clave_oficial, texto, fuente_oficial_fragmento_id)
  select
    (select id from vid),
    (select pi.id from _pub_ids pi where pi.clave = cp.contenido_clave_local),
    cp.clave_local,
    cp.texto,
    (select pi.id from _pub_ids pi where pi.clave = 'fragmento:' || cp.pagina)
  from candidatos_pda cp
  returning id, clave_oficial as clave_local_temporal
)
insert into _pub_ids (clave, id)
select clave_local_temporal, id from insertados;

-- 10b) limpieza: clave_oficial vuelve a NULL
update public.curriculo_pda
set clave_oficial = null
where curriculo_version_id = (select id from _pub_ids where clave='version');

-- ===== 11) CURRICULO_PDA_GRADO: 487 relaciones =====
with candidatos_pg as (
  select * from jsonb_to_recordset({_dq(pda_grados_json, 'pgj')}::jsonb) as x(clave_local text, pda_clave_local text, grado_clave text)
)
insert into public.curriculo_pda_grado (curriculo_pda_id, curriculo_grado_id)
select
  (select pi.id from _pub_ids pi where pi.clave = cpg.pda_clave_local),
  (select pi.id from _pub_ids pi where pi.clave = 'grado:' || cpg.grado_clave)
from candidatos_pg cpg
on conflict (curriculo_pda_id, curriculo_grado_id) do nothing;

-- ===== 12) VALIDACIONES PRE-COMMIT (invariantes exactos, abortan si fallan) =====
-- "0 referencias a grupo/docente" no requiere comprobación SQL: ninguna de
-- las tablas curriculares tiene columna grupo_id/docente_id en el schema
-- (verificado en la auditoría V1-B-4A) -- estructuralmente imposible.
with vid as (select id from _pub_ids where clave='version'),
fid as (select id from _pub_ids where clave='fuente_oficial'),
fase as (select id from _pub_ids where clave='fase'),
checks as (
  select
    (select count(*) from public.fuente_oficial where id = (select id from fid)) as fuente_n,
    (select count(*) from public.fuente_oficial_fragmento where fuente_oficial_id = (select id from fid)) as fragmentos_n,
    (select count(*) from public.curriculo_fase where curriculo_version_id = (select id from vid)) as fase_n,
    (select count(*) from public.curriculo_fase_grado where curriculo_fase_id = (select id from fase)) as fase_grado_n,
    (select count(*) from public.curriculo_grado g join public.curriculo_fase_grado fg on fg.curriculo_grado_id = g.id where fg.curriculo_fase_id = (select id from fase)) as grados_scope_n,
    (select count(*) from public.curriculo_campo_formativo where curriculo_version_id = (select id from vid)) as campos_n,
    (select count(*) from public.curriculo_contenido where curriculo_version_id = (select id from vid)) as contenidos_n,
    (select count(*) from public.curriculo_pda where curriculo_version_id = (select id from vid)) as pda_n,
    (select count(*) from public.curriculo_pda_grado pg join public.curriculo_pda p on p.id = pg.curriculo_pda_id where p.curriculo_version_id = (select id from vid)) as pda_grado_n,
    (select count(*) from public.curriculo_pda_grado pg join public.curriculo_pda p on p.id = pg.curriculo_pda_id join public.curriculo_grado g on g.id = pg.curriculo_grado_id where p.curriculo_version_id = (select id from vid) and g.clave = '3') as grado3_n,
    (select count(*) from public.curriculo_pda_grado pg join public.curriculo_pda p on p.id = pg.curriculo_pda_id join public.curriculo_grado g on g.id = pg.curriculo_grado_id where p.curriculo_version_id = (select id from vid) and g.clave = '4') as grado4_n,
    (select count(*) from public.curriculo_contenido c where c.curriculo_version_id = (select id from vid) and (c.fase_id is null or c.campo_formativo_id is null or c.fuente_oficial_fragmento_id is null)) as contenidos_huerfanos,
    (select count(*) from public.curriculo_pda p where p.curriculo_version_id = (select id from vid) and (p.contenido_id is null or p.fuente_oficial_fragmento_id is null)) as pda_huerfanos,
    (select count(*) from public.curriculo_pda p where p.curriculo_version_id = (select id from vid) and not exists (select 1 from public.curriculo_pda_grado pg where pg.curriculo_pda_id = p.id)) as pda_sin_grado,
    (select count(*) from public.curriculo_eje_articulador where curriculo_version_id = (select id from vid)) as ejes_n
)
-- INVARIANTES_PRECOMMIT_FALLIDOS si dispara division-by-zero real.
select 1 / (case when
    fuente_n = 1 and fragmentos_n = 39 and fase_n = 1 and fase_grado_n = 2 and grados_scope_n = 2
    and campos_n = 4 and contenidos_n = 85 and pda_n = 487 and pda_grado_n = 487
    and grado3_n = 246 and grado4_n = 241
    and contenidos_huerfanos = 0 and pda_huerfanos = 0 and pda_sin_grado = 0
    and ejes_n = 0
  then 1 else 0 end) as invariantes_ok
from checks;

-- ===== 13) CURRICULO_COBERTURA: 8 filas, AL FINAL =====
with vid as (select id from _pub_ids where clave='version'),
fid as (select id from _pub_ids where clave='fase'),
grados as (select id from _pub_ids where clave in ('grado:3','grado:4')),
campos_ids as (select id from _pub_ids where clave in ({", ".join(_dq(c["clave_local"], f"cov{i}") for i, c in enumerate(campos))}))
insert into public.curriculo_cobertura (curriculo_version_id, nivel_educativo, fase_id, grado_id, campo_formativo_id)
select (select id from vid), {_dq(FASE_NIVEL_EDUCATIVO, 'ne7')}, (select id from fid), g.id, c.id
from grados g cross join campos_ids c
on conflict (curriculo_version_id, fase_id, grado_id, campo_formativo_id) do nothing;

-- ===== 13b) Guard final: cobertura debe quedar en exactamente 8 =====
-- (si por cualquier razón no quedó en 8, se aborta TODA la transacción
-- aquí mismo -- "si falla una: ROLLBACK de todo").
with vid as (select id from _pub_ids where clave='version')
-- COBERTURA_INCOMPLETA si dispara division-by-zero real.
select 1 / (case when (select count(*) from public.curriculo_cobertura where curriculo_version_id = (select id from vid)) = 8 then 1 else 0 end) as cobertura_ok;

-- ===== 14) Resumen final (lo que Python recibe como resultado) =====
with vid as (select id from _pub_ids where clave='version'),
fid as (select id from _pub_ids where clave='fuente_oficial')
select
  (select id from fid) as fuente_oficial_id,
  (select id from vid) as curriculo_version_id,
  (select estado from public.curriculo_version where id = (select id from vid)) as version_estado,
  (select count(*) from public.fuente_oficial_fragmento where fuente_oficial_id = (select id from fid)) as fragmentos,
  (select count(*) from public.curriculo_contenido where curriculo_version_id = (select id from vid)) as contenidos,
  (select count(*) from public.curriculo_pda where curriculo_version_id = (select id from vid)) as pda,
  (select count(*) from public.curriculo_pda_grado pg join public.curriculo_pda p on p.id = pg.curriculo_pda_id where p.curriculo_version_id = (select id from vid)) as pda_grado,
  (select count(*) from public.curriculo_cobertura where curriculo_version_id = (select id from vid)) as cobertura;

commit;
""".strip()


def _diagnosticar_fallo() -> dict:
    """Tras un error de división por cero (aborto condicional real de
    alguna guarda), esta función NO adivina cuál guarda disparó a partir
    del texto del error (genérico e indistinguible entre guardas, ver
    docstring del módulo) — en su lugar vuelve a consultar el estado real
    con lecturas de solo lectura, en una sesión NUEVA (la transacción
    fallida ya se revirtió por completo), para reportar una causa
    probable basada en evidencia, no en suposición."""
    sql = f"""
select
  (select count(*) from public.fuente_oficial where hash_archivo = {_dq(FUENTE_HASH_FASE4_CONOCIDA, 'dfh')}) as fuente_oficial_existentes,
  (select count(*) from public.curriculo_version v join public.fuente_oficial f on f.id = v.fuente_oficial_id where f.hash_archivo = {_dq(FUENTE_HASH_FASE4_CONOCIDA, 'dfh2')}) as version_existentes,
  (select count(*) from public.curriculo_fase fa
     join public.curriculo_version v on v.id = fa.curriculo_version_id
     join public.fuente_oficial f on f.id = v.fuente_oficial_id
     where f.hash_archivo = {_dq(FUENTE_HASH_FASE4_CONOCIDA, 'dfh3')} and fa.clave = {_dq(FASE_CLAVE, 'dfc')}) as fase_existentes,
  (select count(*) from public.curriculo_cobertura cc
     join public.curriculo_fase fa on fa.id = cc.fase_id
     join public.curriculo_version v on v.id = fa.curriculo_version_id
     join public.fuente_oficial f on f.id = v.fuente_oficial_id
     where f.hash_archivo = {_dq(FUENTE_HASH_FASE4_CONOCIDA, 'dfh4')} and fa.clave = {_dq(FASE_CLAVE, 'dfc2')}) as cobertura_existente;
""".strip()
    try:
        r = _ejecutar_sql_archivo(sql)
        fila = r.get("rows", [{}])[0]
    except ErrorEjecucionSQL:
        return {"diagnostico": "no se pudo consultar el estado real tras el fallo"}

    if fila.get("fuente_oficial_existentes", 0) > 1:
        return {"causa_probable": "FUENTE_OFICIAL_AMBIGUA", "evidencia": fila}
    if fila.get("version_existentes", 0) > 1:
        return {"causa_probable": "VERSION_AMBIGUA", "evidencia": fila}
    if fila.get("fase_existentes", 0) > 1:
        return {"causa_probable": "FASE_AMBIGUA", "evidencia": fila}
    if fila.get("cobertura_existente", 0) > 0:
        return {"causa_probable": "SCOPE_YA_PUBLICADO", "evidencia": fila}
    return {"causa_probable": "INVARIANTES_O_COBERTURA_FINAL (ver detalle del error de PostgreSQL)", "evidencia": fila}


def publicar(ingesta_id: str) -> dict:
    ingesta, candidatos = leer_staging(ingesta_id)
    validacion = revalidar_staging(ingesta, candidatos)  # lanza ErrorValidacionPublicacion si falla

    fragmentos = construir_fragmentos(candidatos)
    if len(fragmentos) != 39:
        raise ErrorValidacionPublicacion([f"fragmentos reconstruidos={len(fragmentos)} (esperado 39)"])
    anomalos = [f for f in fragmentos if f["seccion"] is None]
    if anomalos:
        raise ErrorValidacionPublicacion([
            f"página {f['pagina']} referencia más de un campo formativo ({f['campos_de_pagina']}) -- no se puede asignar una sección inequívoca"
            for f in anomalos
        ])

    sql = construir_sql_publicacion(candidatos, fragmentos)

    reporte = {
        "ingesta_id": ingesta_id,
        "validacion_staging": validacion,
        "fragmentos_reconstruidos": len(fragmentos),
    }

    try:
        resultado = _ejecutar_sql_archivo(sql)
    except ErrorEjecucionSQL as e:
        diagnostico = _diagnosticar_fallo()
        reporte["publicado"] = False
        reporte["detalle_error_postgresql"] = str(e)
        reporte["diagnostico"] = diagnostico
        if diagnostico.get("causa_probable") == "SCOPE_YA_PUBLICADO":
            # Único resultado de aborto ESPERADO/normal -- no se relanza
            # como excepción, es un no-op válido, 0 escrituras.
            reporte["resultado"] = "SCOPE_YA_PUBLICADO"
            return reporte
        # Cualquier otra causa es una anomalía real -- no se tapa, se
        # relanza para que el operador la inspeccione.
        reporte["resultado"] = diagnostico.get("causa_probable", "ERROR_NO_CLASIFICADO")
        raise ErrorEjecucionSQL(json.dumps(reporte, ensure_ascii=False)) from e

    filas = resultado.get("rows", [])
    if not filas:
        raise ErrorEjecucionSQL(f"la publicación no devolvió fila de resumen: {resultado}")

    reporte["resultado"] = "PUBLICADO"
    reporte["publicado"] = True
    reporte["resumen"] = filas[0]
    return reporte


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ingesta-id", required=True)
    args = ap.parse_args()

    try:
        reporte = publicar(args.ingesta_id)
    except (ErrorValidacionPublicacion, ErrorEjecucionSQL) as e:
        print("PUBLICACIÓN FALLIDA — 0 escrituras confirmadas (fail-closed):", file=sys.stderr)
        if isinstance(e, ErrorValidacionPublicacion):
            for p in e.args[0]:
                print(f"  - {p}", file=sys.stderr)
        else:
            print(f"  {e}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(reporte, ensure_ascii=False, indent=2))
    if not reporte["publicado"]:
        print(f"\nResultado: {reporte['resultado']} (0 escrituras confirmadas)", file=sys.stderr)


if __name__ == "__main__":
    main()
