"""Transformación determinista — Currículo V1-B-3A.

Convierte la salida ya validada del extractor (extractor.py) en:

  (a) un registro de identidad de ingesta compatible con
      ingesta_curricular (fuente_hash, perfil_extractor,
      version_pipeline, scope_solicitado, scope_hash), y
  (b) una lista de candidatos compatibles con
      ingesta_curricular_candidato (tipo, clave_local, parent_local,
      payload, fingerprint, evidencia, estado_validacion, origen).

NO escribe en Supabase. NO publica en las 11 tablas canónicas de V1-A. Es
una transformación puramente local, determinista, sin IA y sin
interpretación semántica: cada candidato es una copia estructurada de lo
que el extractor ya extrajo, nunca un dato inferido aquí.

Relaciones conservadas (nunca inferidas de nuevo):

    campo -> contenido -> pda -> pda_grado

Un contenido pertenece a campo (vía versión, resuelta en la publicación
canónica futura, no aquí) y NUNCA se duplica por grado. La aplicabilidad
por grado de cada PDA se representa con un candidato `pda_grado`
independiente, incluso cuando en este documento cada PDA candidato resulta
tener un único grado aplicable — la relación se modela igual de explícita
que si pudiera ser N a N, para no presuponer 1 a 1 en el esquema.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter

VERSION_TRANSFORMADOR = "0.1.0"


class ErrorValidacionStaging(Exception):
    """Se lanza cuando la transformación no cumple alguna de las
    validaciones fail-closed obligatorias — en ese caso NUNCA debe
    escribirse nada a staging."""


def version_pipeline_combinada(version_extractor: str) -> str:
    return f"extractor:{version_extractor}+transformador:{VERSION_TRANSFORMADOR}"


def construir_scope_canonico(extraccion: dict) -> dict:
    """Representación canónica y determinista del scope curricular
    realmente extraído — nunca el grupo/docente que lo vaya a usar. Mismos
    valores de entrada producen siempre el mismo dict (claves fijas,
    arrays ordenados y sin duplicados)."""
    scope = extraccion["scope"]
    return {
        "nivel_educativo": scope["nivel_educativo"],
        "fase_clave": scope["fase_clave"],
        "grados": sorted(set(scope["grados"])),
        "campos": sorted(set(scope["campos"])),
    }


def calcular_scope_hash(scope_canonico: dict) -> str:
    serializado = json.dumps(scope_canonico, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(serializado.encode("utf-8")).hexdigest()


def construir_identidad_ingesta(extraccion: dict) -> dict:
    scope_canonico = construir_scope_canonico(extraccion)
    return {
        "fuente_hash": extraccion["fuente"]["sha256"],
        "fuente_url": None,  # se completa en la microfase de escritura real, con la URL oficial verificada
        "perfil_extractor": extraccion["perfil_extractor"],
        "version_pipeline": version_pipeline_combinada(extraccion["version_pipeline"]),
        "scope_solicitado": scope_canonico,
        "scope_hash": calcular_scope_hash(scope_canonico),
        "metadata": {
            "organismo": extraccion["fuente"]["organismo"],
            "titulo_documento": extraccion["fuente"]["titulo_documento"],
            "version_edicion": extraccion["fuente"]["version_edicion"],
            "paginas_totales": extraccion["fuente"]["paginas_totales"],
        },
    }


def _fingerprint(*partes: str) -> str:
    return hashlib.sha256("||".join(str(p) for p in partes).encode("utf-8")).hexdigest()


def transformar_candidatos(extraccion: dict) -> list[dict]:
    candidatos: list[dict] = []

    for campo in extraccion["campos"]:
        clave_campo = f"campo:{campo['clave']}"
        candidatos.append({
            "tipo": "campo",
            "clave_local": clave_campo,
            "parent_local": None,
            "payload": {"clave": campo["clave"], "nombre": campo["nombre"]},
            "fingerprint": _fingerprint("campo", campo["clave"]),
            "evidencia": {"paginas": campo["paginas"]},
            "estado_validacion": "confirmado",
            "origen": "regla",
        })

        for contenido in campo["contenidos"]:
            clave_contenido = f"contenido:{contenido['clave_local']}"
            titulo = contenido["titulo"]
            candidatos.append({
                "tipo": "contenido",
                "clave_local": clave_contenido,
                "parent_local": clave_campo,
                "payload": {
                    "clave_oficial": None,
                    "titulo": titulo["texto_normalizado"],
                },
                "fingerprint": _fingerprint("contenido", clave_campo, titulo["texto_normalizado"]),
                "evidencia": {
                    "texto_original": titulo["texto_original"],
                    "normalizacion_aplicada": titulo["normalizacion_aplicada"],
                    "pagina": titulo["evidencia"]["pagina"],
                    "top": titulo["evidencia"]["top"],
                    "bottom": titulo["evidencia"]["bottom"],
                    "fragmento_local": titulo["evidencia"]["fragmento_local"],
                    "paginas": contenido["paginas"],
                    "continuacion": contenido.get("continuacion"),
                },
                "estado_validacion": contenido["estado_validacion"],
                "origen": "regla",
            })

            # Nota sobre unicidad: el `clave_local` que el extractor
            # embebe en cada PDA (p. ej. "...#pda#3#0") se calcula con un
            # índice LOCAL a la llamada de extracción de una sola celda —
            # colisiona cuando un mismo contenido recibe PDA del mismo
            # grado en más de una fila de tabla (el caso real observado:
            # un contenido con continuación entre páginas acumula PDA de
            # la fila de la página 25 Y de la fila de continuación de la
            # página 26, cada una reiniciando su índice en 0). Por eso la
            # clave_local de STAGING se deriva de la posición GLOBAL
            # dentro de la lista ya aplanada `contenido["pda"]` — que sí
            # es única y determinista por construcción (siempre el mismo
            # orden de recorrido para los mismos bytes) — en vez de
            # reutilizar ciegamente el clave_local interno del extractor.
            # No se modifica extractor.py: el problema es de identidad de
            # STAGING, responsabilidad de este módulo.
            for idx_pda, pda in enumerate(contenido["pda"]):
                clave_pda = f"pda:{clave_contenido}#pda#{idx_pda}"
                texto = pda["texto"]
                candidatos.append({
                    "tipo": "pda",
                    "clave_local": clave_pda,
                    "parent_local": clave_contenido,
                    "payload": {
                        "clave_oficial": None,
                        "texto": texto["texto_normalizado"],
                    },
                    "fingerprint": _fingerprint("pda", clave_contenido, pda["grado"], texto["texto_normalizado"]),
                    "evidencia": {
                        "texto_original": texto["texto_original"],
                        "normalizacion_aplicada": texto["normalizacion_aplicada"],
                        "pagina": texto["evidencia"]["pagina"],
                        "top": texto["evidencia"]["top"],
                        "bottom": texto["evidencia"]["bottom"],
                        "fragmento_local": texto["evidencia"]["fragmento_local"],
                        # Identidad interna que el extractor le dio a este
                        # PDA (puede no ser única entre sí, ver nota
                        # arriba) — se conserva solo como referencia de
                        # auditoría hacia la corrida de extracción, nunca
                        # como clave.
                        "extractor_clave_local": pda["clave_local"],
                    },
                    "estado_validacion": pda["estado_validacion"],
                    "origen": "regla",
                })

                clave_pda_grado = f"pda_grado:{clave_pda}"
                candidatos.append({
                    "tipo": "pda_grado",
                    "clave_local": clave_pda_grado,
                    "parent_local": clave_pda,
                    "payload": {"grado_clave": pda["grado"]},
                    "fingerprint": _fingerprint("pda_grado", clave_pda, pda["grado"]),
                    "evidencia": {},
                    "estado_validacion": pda["estado_validacion"],
                    "origen": "regla",
                })

    return candidatos


def verificar_invariantes_conocidos(reporte: dict, invariantes: dict) -> list[str]:
    """Comprobación de regresión EXPLÍCITA contra conteos ya conocidos de
    una fuente/perfil específicos (p. ej. los 4/85/246/241 confirmados
    para Fase 4 al cerrar V1-B-2). Deliberadamente SEPARADA de
    `validar_staging` — esos conteos son propios de ESTE documento, no
    una regla universal del transformador: un perfil distinto (Fase 2, 3,
    5...) tendrá sus propios conteos reales, nunca estos. `invariantes` es
    un dict {clave_del_reporte: valor_esperado}; devuelve la lista de
    discrepancias (vacía si todo coincide).
    """
    discrepancias = []
    for clave, esperado in invariantes.items():
        real = reporte.get(clave)
        if real != esperado:
            discrepancias.append(f"{clave}={real} (esperado {esperado})")
    return discrepancias


def validar_staging(extraccion: dict, candidatos: list[dict]) -> dict:
    """Fail-closed y AGNÓSTICO DE PERFIL: lanza ErrorValidacionStaging si
    cualquiera de las comprobaciones estructurales obligatorias falla,
    sin importar cuál perfil/documento se esté procesando. No se debe
    escribir nada a staging a menos que esta función retorne sin
    excepción. Los conteos específicos de un documento conocido (p. ej.
    Fase 4) se verifican aparte con `verificar_invariantes_conocidos`."""
    problemas: list[str] = []
    r = extraccion["reporte"]

    if r["dudosos"] != 0:
        problemas.append(f"dudosos={r['dudosos']} (esperado 0)")
    if r["errores"]:
        problemas.append(f"errores del extractor no vacíos: {r['errores']}")
    if r["celdas_sin_asignar"]:
        problemas.append(f"celdas_sin_asignar no vacío: {r['celdas_sin_asignar']}")
    if r["paginas_estructura_inesperada"]:
        problemas.append(f"paginas_estructura_inesperada no vacío: {r['paginas_estructura_inesperada']}")

    # --- estructurales sobre los candidatos ya transformados ---
    claves = [c["clave_local"] for c in candidatos]
    duplicadas = [k for k, n in Counter(claves).items() if n > 1]
    if duplicadas:
        problemas.append(f"clave_local duplicada dentro de la ingesta: {duplicadas}")

    claves_existentes = set(claves)
    for c in candidatos:
        if c["parent_local"] is not None and c["parent_local"] not in claves_existentes:
            problemas.append(f"referencia padre inexistente: {c['clave_local']} -> {c['parent_local']}")

    # ningún contenido sin campo / ningún pda sin contenido: ya cubierto
    # arriba por la comprobación de referencia padre (todo contenido tiene
    # parent_local=campo:..., todo pda tiene parent_local=contenido:...),
    # pero se re-verifica explícitamente por tipo para dejar la garantía
    # inequívoca, no implícita.
    padres_por_clave = {c["clave_local"]: c["parent_local"] for c in candidatos}
    tipos_por_clave = {c["clave_local"]: c["tipo"] for c in candidatos}
    for c in candidatos:
        if c["tipo"] == "contenido":
            padre = padres_por_clave.get(c["clave_local"])
            if padre is None or tipos_por_clave.get(padre) != "campo":
                problemas.append(f"contenido sin campo válido: {c['clave_local']}")
        if c["tipo"] == "pda":
            padre = padres_por_clave.get(c["clave_local"])
            if padre is None or tipos_por_clave.get(padre) != "contenido":
                problemas.append(f"pda sin contenido válido: {c['clave_local']}")

    # ningún pda sin grado: todo candidato tipo=pda debe tener al menos un
    # pda_grado hijo (el grado NUNCA vive en el propio pda, vive en la
    # relación, igual que en el esquema canónico V1-A).
    pdas = {c["clave_local"] for c in candidatos if c["tipo"] == "pda"}
    pdas_con_grado = {c["parent_local"] for c in candidatos if c["tipo"] == "pda_grado"}
    sin_grado = pdas - pdas_con_grado
    if sin_grado:
        problemas.append(f"PDA sin ninguna relación pda_grado: {sorted(sin_grado)}")

    if any(c["estado_validacion"] == "dudoso" for c in candidatos):
        dudosos_local = [c["clave_local"] for c in candidatos if c["estado_validacion"] == "dudoso"]
        problemas.append(f"candidatos en estado dudoso (no se publica nada con dudas sin resolver): {dudosos_local}")

    if problemas:
        raise ErrorValidacionStaging(problemas)

    return {
        "ok": True,
        "total_candidatos": len(candidatos),
        "por_tipo": dict(Counter(c["tipo"] for c in candidatos)),
    }
