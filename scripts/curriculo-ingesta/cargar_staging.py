#!/usr/bin/env python3
"""Primera carga real a staging — Currículo V1-B-3B.

PDF oficial -> extractor -> transformación -> validación (re-ejecutadas en
ESTA MISMA corrida, nunca se confía en un preview previo) -> resolución de
idempotencia -> escritura ATÓMICA de (ingesta_curricular +
ingesta_curricular_candidato) -> read-back completo -> comparación
fingerprint-por-fingerprint contra la transformación local.

NO escribe jamás en ninguna de las 11 tablas canónicas de V1-A ni en
curriculo_cobertura. NO usa IA. NO usa OCR.

Autoridad/credenciales: esta herramienta NUNCA maneja el service_role
directamente. Toda escritura y lectura se delega al mecanismo
administrativo ya existente y probado en este repositorio para el proyecto
Supabase vinculado: `supabase db query --linked` (Supabase CLI, ya
autenticado fuera de este script). El script solo genera SQL parametrizado
de forma segura (vía JSON + `jsonb_to_recordset`, nunca interpolación cruda
de texto extraído del PDF) y lo pasa a la CLI mediante un archivo temporal
(`--file`), nunca como argumento de línea de comandos ni impreso en logs.

Atomicidad — DISEÑO VERIFICADO EMPÍRICAMENTE, no asumido:

  Statement 1 (ATÓMICO REAL, un solo comando SQL): INSERT en
  ingesta_curricular (estado='en_progreso') encadenado, vía CTEs de
  escritura, con el INSERT masivo de los N candidatos en
  ingesta_curricular_candidato (usando jsonb_to_recordset). El statement
  PRIMARIO es un SELECT puro (nunca un INSERT/UPDATE adicional) que solo
  lee los resultados de ambas CTE vía RETURNING. Verificado contra la
  base real (con datos descartables, limpiados de inmediato) que esto
  es una unidad atómica genuina: si el INSERT masivo de candidatos falla
  por cualquier constraint, TODO el statement se revierte, incluida la
  fila de ingesta_curricular — nunca queda una ingesta huérfana con
  candidatos parciales.

  Statement 2 (separado, trivial, una sola tabla): UPDATE
  ingesta_curricular SET estado='completado' WHERE id=... AND
  estado='en_progreso'. Se intentó primero fusionar esto dentro del
  MISMO statement del punto anterior (un UPDATE como statement primario
  del WITH, en vez de un SELECT) — SE PROBÓ CONTRA LA BASE REAL (con
  datos descartables) y **no funcionó**: el UPDATE, cuando es el
  statement primario de un WITH cuyas CTEs ya modifican la MISMA tabla
  (ingesta_curricular), no aplicó su SET pese a no arrojar ningún error
  — la fila quedaba con los candidatos correctamente insertados pero el
  estado seguía en 'en_progreso'. Este es un hallazgo real, reproducido
  dos veces (un caso mínimo de una sola CTE y el caso completo), no una
  suposición. Por eso el cambio de estado a 'completado' se hace en un
  segundo statement, separado, de una sola tabla — sin ningún riesgo de
  candidatos parciales (ya garantizado por el Statement 1), con el único
  riesgo residual de que, en el caso extremadamente improbable de un
  fallo justo entre ambos statements, la ingesta quede correctamente
  completa en sus candidatos pero con estado='en_progreso' en vez de
  'completado' — un estado seguro, inspeccionable y corregible
  manualmente, nunca datos incompletos ni duplicados. No fue necesaria
  ninguna función ni migración nueva.

Uso:
    ./.venv/bin/python3 cargar_staging.py --pdf <ruta.pdf>
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from idempotencia import decidir_estrategia_preliminar, resolver_verificacion_readback
from transformador import (
    ErrorValidacionStaging,
    construir_identidad_ingesta,
    transformar_candidatos,
    validar_staging,
    verificar_invariantes_conocidos,
)

INVARIANTES_FASE4_CONOCIDOS = {
    "campos_detectados": 4,
    "contenidos_detectados": 85,
    "pda_3_detectados": 246,
    "pda_4_detectados": 241,
    "continuaciones_detectadas": 13,
    "dudosos": 0,
    "tablas_detectadas": 39,
}
FUENTE_HASH_FASE4_CONOCIDA = "36e0c3cdbc3221cdf9c4b9f3ec9e889f98060249fc0ab1ddecd419b28bcbe734"
# URL oficial verificada del documento (ver auditoría previa) — trazabilidad
# únicamente. Nunca participa en la identidad/scope_hash de la ingesta:
# construir_scope_canonico (transformador.py) no la lee, y scope_hash se
# calcula exclusivamente sobre nivel_educativo/fase_clave/grados/campos.
FUENTE_URL_FASE4_CONOCIDA = "https://educacionbasica.sep.gob.mx/wp-content/uploads/2024/06/Programa_Sintetico_Fase_4.pdf"
RAIZ_PROYECTO = str(Path(__file__).resolve().parent.parent.parent)

TIPOS_CANDIDATO_COLUMNAS = "tipo text, clave_local text, parent_local text, payload jsonb, fingerprint text, evidencia jsonb, estado_validacion text, origen text"


class ErrorEjecucionSQL(Exception):
    pass


def _ejecutar_sql_archivo(sql: str) -> dict:
    """Escribe `sql` a un archivo temporal y lo ejecuta vía la CLI de
    Supabase ya autenticada (`supabase db query --linked --file`). Nunca
    imprime ni maneja el service_role directamente — la CLI gestiona la
    autenticación por su cuenta. Devuelve el JSON parseado de la última
    línea de salida (la CLI antepone líneas informativas no-JSON)."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write(sql)
        ruta = f.name
    try:
        resultado = subprocess.run(
            ["npx", "supabase", "db", "query", "--linked", "--file", ruta],
            capture_output=True, text=True, timeout=120,
            cwd=RAIZ_PROYECTO,  # supabase/.temp/project-ref vive en la raíz del repo, no en scripts/curriculo-ingesta/
        )
    finally:
        Path(ruta).unlink(missing_ok=True)

    if resultado.returncode != 0:
        raise ErrorEjecucionSQL(f"supabase db query falló (code={resultado.returncode}): {resultado.stderr}\n{resultado.stdout}")

    # `subprocess` entrega stdout/stderr en flujos separados (a diferencia
    # de cómo se ven combinados en una terminal interactiva) — stdout
    # contiene EXCLUSIVAMENTE el JSON de respuesta (pretty-printed en
    # varias líneas, nunca una sola línea), y stderr las líneas
    # informativas de la CLI ("Initialising login role..."). Parsear
    # stdout completo, nunca una sola línea de él.
    try:
        return json.loads(resultado.stdout)
    except json.JSONDecodeError as e:
        raise ErrorEjecucionSQL(f"salida no es JSON válido ({e}): stdout={resultado.stdout!r} stderr={resultado.stderr!r}")


def _dq(texto: str, tag: str) -> str:
    """Dollar-quoting seguro con una etiqueta única — evita por completo
    los problemas de escapado de comillas simples en texto real extraído
    del PDF (apóstrofes, acentos, etc.), que es exactamente lo que
    'inserts manuales improvisados' con interpolación cruda arriesgaría."""
    marcador = f"${tag}$"
    assert marcador not in texto, f"colisión de marcador dollar-quote: {marcador}"
    return f"{marcador}{texto}{marcador}"


def construir_sql_verificacion_identidad(identidad: dict) -> str:
    return f"""
select id, estado, iniciado_en, finalizado_en
from public.ingesta_curricular
where fuente_hash = {_dq(identidad['fuente_hash'], 'fh')}
  and perfil_extractor = {_dq(identidad['perfil_extractor'], 'pe')}
  and version_pipeline = {_dq(identidad['version_pipeline'], 'vp')}
  and scope_hash = {_dq(identidad['scope_hash'], 'sh')}
order by iniciado_en;
""".strip()


def construir_sql_carga_atomica(identidad: dict, candidatos: list[dict]) -> str:
    candidatos_json = json.dumps(candidatos, ensure_ascii=False)
    scope_json = json.dumps(identidad["scope_solicitado"], ensure_ascii=False)
    metadata_json = json.dumps(identidad["metadata"], ensure_ascii=False)
    fuente_url_sql = "null" if identidad["fuente_url"] is None else _dq(identidad["fuente_url"], "furl")

    return f"""
with nueva_ingesta as (
  insert into public.ingesta_curricular
    (fuente_hash, fuente_url, perfil_extractor, version_pipeline, scope_solicitado, scope_hash, estado, metadata)
  values (
    {_dq(identidad['fuente_hash'], 'fh')},
    {fuente_url_sql},
    {_dq(identidad['perfil_extractor'], 'pe')},
    {_dq(identidad['version_pipeline'], 'vp')},
    {_dq(scope_json, 'sj')}::jsonb,
    {_dq(identidad['scope_hash'], 'sh')},
    'en_progreso',
    {_dq(metadata_json, 'mj')}::jsonb
  )
  returning id
),
candidatos_insertados as (
  insert into public.ingesta_curricular_candidato
    (ingesta_id, tipo, clave_local, parent_local, payload, fingerprint, evidencia, estado_validacion, origen)
  select (select id from nueva_ingesta), x.tipo, x.clave_local, x.parent_local, x.payload, x.fingerprint, x.evidencia, x.estado_validacion, x.origen
  from jsonb_to_recordset({_dq(candidatos_json, 'cj')}::jsonb) as x({TIPOS_CANDIDATO_COLUMNAS})
  returning 1
)
select
  (select id from nueva_ingesta) as id,
  (select count(*) from candidatos_insertados) as candidatos_insertados;
""".strip()


def construir_sql_marcar_completado(ingesta_id: str, candidatos_esperados: int) -> str:
    """Statement 2, separado y trivial (una sola tabla) — ver nota de
    atomicidad en el docstring del módulo sobre por qué esto NO se
    fusiona con el statement 1. Condicionado a que el conteo de
    candidatos ya persistidos coincida exactamente con lo esperado
    (defensa adicional: si por cualquier razón no coincidiera, nunca se
    marca 'completado' una ingesta con candidatos distintos a los
    esperados)."""
    return f"""
update public.ingesta_curricular
set estado = 'completado', finalizado_en = now()
where id = {_dq(ingesta_id, 'iid')}
  and estado = 'en_progreso'
  and (select count(*) from public.ingesta_curricular_candidato where ingesta_id = {_dq(ingesta_id, 'iid2')}) = {int(candidatos_esperados)}
returning id, fuente_hash, perfil_extractor, version_pipeline, scope_hash, estado;
""".strip()


def construir_sql_readback(ingesta_id: str) -> str:
    return f"""
select tipo, clave_local, parent_local, fingerprint, estado_validacion
from public.ingesta_curricular_candidato
where ingesta_id = {_dq(ingesta_id, 'iid')}
order by tipo, clave_local;
""".strip()


def construir_sql_readback_identidad(ingesta_id: str) -> str:
    return f"""
select id, fuente_hash, perfil_extractor, version_pipeline, scope_hash, estado
from public.ingesta_curricular
where id = {_dq(ingesta_id, 'iid')};
""".strip()


def construir_sql_conteo_canonicas_vacias() -> str:
    tablas = [
        "fuente_oficial", "fuente_oficial_fragmento", "curriculo_version",
        "curriculo_grado", "curriculo_fase", "curriculo_fase_grado",
        "curriculo_campo_formativo", "curriculo_contenido", "curriculo_pda",
        "curriculo_pda_grado", "curriculo_eje_articulador", "curriculo_cobertura",
    ]
    partes = [f"select {i} as orden, '{t}' as tabla, count(*) as n from public.{t}" for i, t in enumerate(tablas)]
    return "\nunion all\n".join(partes) + "\norder by orden;"


def cargar(pdf_path: str) -> dict:
    from extractor import extraer
    from perfiles import PERFIL_PROGRAMA_SINTETICO_FASE4_2024

    # 1) re-extracción + re-transformación + re-validación en ESTA MISMA
    #    corrida -- nunca se confía en un preview previo.
    extraccion = extraer(pdf_path, PERFIL_PROGRAMA_SINTETICO_FASE4_2024)

    if extraccion["fuente"]["sha256"] != FUENTE_HASH_FASE4_CONOCIDA:
        raise ErrorValidacionStaging([f"sha256 inesperado: {extraccion['fuente']['sha256']}"])

    discrepancias = verificar_invariantes_conocidos(extraccion["reporte"], INVARIANTES_FASE4_CONOCIDOS)
    if discrepancias:
        raise ErrorValidacionStaging(discrepancias)

    candidatos = transformar_candidatos(extraccion)
    validacion = validar_staging(extraccion, candidatos)  # lanza si falla

    identidad = construir_identidad_ingesta(extraccion)
    if identidad["fuente_hash"] == FUENTE_HASH_FASE4_CONOCIDA and identidad["fuente_url"] is None:
        # Trazabilidad únicamente -- no participa en scope_hash (ver
        # constante arriba). Solo se aplica a NUEVAS ingestas: la fila ya
        # persistida (cfe890b8-...) NUNCA se actualiza en esta ronda.
        identidad = {**identidad, "fuente_url": FUENTE_URL_FASE4_CONOCIDA}

    # 2) idempotencia -- FASE 1: decisión preliminar solo con estado
    resultado_check = _ejecutar_sql_archivo(construir_sql_verificacion_identidad(identidad))
    ingestas_existentes = resultado_check.get("rows", [])
    decision_preliminar = decidir_estrategia_preliminar(ingestas_existentes)

    decision = decision_preliminar
    readback_previo = None
    if decision_preliminar.requiere_readback:
        # FASE 2: nunca se acepta una ingesta existente solo porque su
        # identidad coincide -- se lee su contenido real y se compara
        # candidato por candidato contra la transformación actual.
        resultado_readback_previo = _ejecutar_sql_archivo(
            construir_sql_readback(decision_preliminar.ingesta_existente_id)
        )
        readback_previo = resultado_readback_previo.get("rows", [])
        decision = resolver_verificacion_readback(decision_preliminar, readback_previo, candidatos)

    reporte = {
        "identidad": identidad,
        "validacion_local": validacion,
        "decision_idempotencia": {
            "estrategia": decision.estrategia,
            "motivo": decision.motivo,
            "ingesta_existente_id": decision.ingesta_existente_id,
        },
        "candidatos_transformados": candidatos,
    }

    if decision.estrategia == "abortar_conflicto":
        reporte["escritura"] = None
        return reporte

    if decision.estrategia == "reutilizar_completada":
        # NO-OP exitoso: 0 INSERT, 0 UPDATE, 0 DELETE. Ya se verificó
        # coincidencia exacta contra readback_previo en la fase 2.
        reporte["escritura"] = {
            "no_op": True,
            "ingesta_id": decision.ingesta_existente_id,
            "readback_candidatos": readback_previo,
        }
        return reporte

    if decision.estrategia == "recuperar_en_progreso":
        # Los candidatos YA coinciden exactamente (verificado en fase 2)
        # -- solo falta el statement 2 (transición de estado), nunca se
        # reinserta nada.
        ingesta_id = decision.ingesta_existente_id
        resultado_completado = _ejecutar_sql_archivo(
            construir_sql_marcar_completado(ingesta_id, len(readback_previo))
        )
        if not resultado_completado.get("rows"):
            raise ErrorEjecucionSQL(
                f"no se pudo marcar 'completado' la ingesta recuperada {ingesta_id} -- "
                f"queda en 'en_progreso', estado seguro pero requiere revisión manual"
            )
        readback = _ejecutar_sql_archivo(construir_sql_readback(ingesta_id))
        reporte["escritura"] = {
            "no_op": False,
            "recuperada": True,
            "ingesta_id": ingesta_id,
            "fila_completado": resultado_completado["rows"][0],
            "readback_candidatos": readback["rows"],
        }
        return reporte

    # decision.estrategia == "crear_nueva"
    # 3) Statement 1: escritura atómica real de ingesta+candidatos -- ver
    #    docstring del módulo para la verificación empírica de esta
    #    garantía.
    resultado_write = _ejecutar_sql_archivo(construir_sql_carga_atomica(identidad, candidatos))
    if not resultado_write.get("rows"):
        raise ErrorEjecucionSQL(f"el statement de carga atómica no devolvió fila: {resultado_write}")
    fila = resultado_write["rows"][0]
    ingesta_id = fila["id"]
    candidatos_insertados_reportado = fila["candidatos_insertados"]

    if candidatos_insertados_reportado != len(candidatos):
        # No debería poder pasar (el statement 1 es atómico), pero se
        # verifica explícitamente antes de continuar -- nunca se asume.
        raise ErrorEjecucionSQL(
            f"candidatos_insertados={candidatos_insertados_reportado} != esperados={len(candidatos)} "
            f"para ingesta {ingesta_id} -- NO se marca completado, requiere inspección manual"
        )

    # 4) Statement 2: transición de estado, separado y trivial (ver nota
    #    de atomicidad) -- condicionado al conteo exacto ya confirmado.
    resultado_completado = _ejecutar_sql_archivo(
        construir_sql_marcar_completado(ingesta_id, candidatos_insertados_reportado)
    )
    if not resultado_completado.get("rows"):
        raise ErrorEjecucionSQL(
            f"no se pudo marcar 'completado' la ingesta {ingesta_id} (candidatos SÍ están completos) -- "
            f"queda en 'en_progreso', estado seguro pero requiere revisión manual"
        )

    # 5) read-back completo
    readback = _ejecutar_sql_archivo(construir_sql_readback(ingesta_id))
    readback_identidad = _ejecutar_sql_archivo(construir_sql_readback_identidad(ingesta_id))

    reporte["escritura"] = {
        "no_op": False,
        "ingesta_id": ingesta_id,
        "fila_completado": resultado_completado["rows"][0],
        "readback_candidatos": readback["rows"],
        "readback_identidad": readback_identidad["rows"][0] if readback_identidad["rows"] else None,
    }
    return reporte


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pdf", required=True)
    args = ap.parse_args()

    try:
        reporte = cargar(args.pdf)
    except ErrorValidacionStaging as e:
        print("VALIDACIÓN/REGRESIÓN FALLIDA — 0 WRITES:", file=sys.stderr)
        for p in e.args[0]:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(1)
    except ErrorEjecucionSQL as e:
        print(f"ERROR DE EJECUCIÓN SQL: {e}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(reporte, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
