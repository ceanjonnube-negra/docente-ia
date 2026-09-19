#!/usr/bin/env python3
"""Preview local de la ingesta de staging — Currículo V1-B-3A.

PDF oficial (o JSON ya extraído) -> extractor V1-B-2 -> transformación
determinista -> candidatos de staging -> validación fail-closed -> PREVIEW.

NO escribe en Supabase bajo ninguna circunstancia — ni en
ingesta_curricular/ingesta_curricular_candidato ni en las 11 tablas
canónicas de V1-A. Es exclusivamente un preview local para revisión antes
de autorizar la primera carga real.

Uso:
    ./.venv/bin/python3 preview_ingesta.py --pdf <ruta.pdf> [--salida <preview.json>]
    ./.venv/bin/python3 preview_ingesta.py --entrada <extraccion.json> [--salida <preview.json>]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter

from transformador import (
    construir_identidad_ingesta,
    transformar_candidatos,
    validar_staging,
    verificar_invariantes_conocidos,
    ErrorValidacionStaging,
)

# Invariantes de regresión conocidos para ESTE documento específico
# (Programa Sintético Fase 4, confirmados al cerrar V1-B-2, commit
# c3817debaa4edca13e47b3e375df6e30b1b1f656) — NO son una regla universal
# del transformador (ver verificar_invariantes_conocidos en
# transformador.py), son la huella de regresión de esta fuente concreta.
INVARIANTES_FASE4_CONOCIDOS = {
    "campos_detectados": 4,
    "contenidos_detectados": 85,
    "pda_3_detectados": 246,
    "pda_4_detectados": 241,
    "continuaciones_detectadas": 13,
    "dudosos": 0,
    "tablas_detectadas": 39,
}


def _muestra(candidatos: list[dict], tipo: str, n: int = 1) -> list[dict]:
    return [c for c in candidatos if c["tipo"] == tipo][:n]


def generar_preview(extraccion: dict) -> dict:
    identidad = construir_identidad_ingesta(extraccion)
    candidatos = transformar_candidatos(extraccion)
    resultado_validacion = validar_staging(extraccion, candidatos)  # lanza si falla — fail closed

    muestras = {
        "campo": _muestra(candidatos, "campo"),
        "contenido": _muestra(candidatos, "contenido"),
        "pda_grado_3": [c for c in candidatos if c["tipo"] == "pda" and
                         any(pg["payload"]["grado_clave"] == "3" and pg["parent_local"] == c["clave_local"]
                             for pg in candidatos if pg["tipo"] == "pda_grado")][:1],
        "pda_grado_4": [c for c in candidatos if c["tipo"] == "pda" and
                         any(pg["payload"]["grado_clave"] == "4" and pg["parent_local"] == c["clave_local"]
                             for pg in candidatos if pg["tipo"] == "pda_grado")][:1],
        "pda_grado_relacion": _muestra(candidatos, "pda_grado", 2),
    }

    return {
        "identidad_ingesta": identidad,
        "validacion": resultado_validacion,
        "total_candidatos": len(candidatos),
        "candidatos_por_tipo": dict(Counter(c["tipo"] for c in candidatos)),
        "muestras": muestras,
        "candidatos": candidatos,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    grupo = ap.add_mutually_exclusive_group(required=True)
    grupo.add_argument("--pdf", help="Ruta local al PDF oficial (se ejecuta el extractor)")
    grupo.add_argument("--entrada", help="Ruta a un JSON de extracción ya generado por extractor.py")
    ap.add_argument("--salida", help="Ruta de salida del preview completo en JSON (opcional)")
    args = ap.parse_args()

    if args.pdf:
        from extractor import extraer
        from perfiles import PERFIL_PROGRAMA_SINTETICO_FASE4_2024
        extraccion = extraer(args.pdf, PERFIL_PROGRAMA_SINTETICO_FASE4_2024)
    else:
        with open(args.entrada, "r", encoding="utf-8") as f:
            extraccion = json.load(f)

    # Regresión explícita contra el documento conocido (Fase 4) ANTES de
    # aceptar el preview como válido — si CUALQUIER conteo cambió
    # respecto a lo ya confirmado en V1-B-2, se detiene aquí y se reporta
    # la causa, nunca se racionaliza automáticamente.
    if extraccion["fuente"]["sha256"] == "36e0c3cdbc3221cdf9c4b9f3ec9e889f98060249fc0ab1ddecd419b28bcbe734":
        discrepancias = verificar_invariantes_conocidos(extraccion["reporte"], INVARIANTES_FASE4_CONOCIDOS)
        if discrepancias:
            print("REGRESIÓN FALLIDA contra los invariantes conocidos de Fase 4 — NO SE GENERA STAGING:", file=sys.stderr)
            for d in discrepancias:
                print(f"  - {d}", file=sys.stderr)
            sys.exit(1)

    try:
        preview = generar_preview(extraccion)
    except ErrorValidacionStaging as e:
        print("VALIDACIÓN FALLIDA — NO SE GENERA STAGING (fail-closed):", file=sys.stderr)
        for problema in e.args[0]:
            print(f"  - {problema}", file=sys.stderr)
        sys.exit(1)

    if args.salida:
        with open(args.salida, "w", encoding="utf-8") as f:
            json.dump(preview, f, ensure_ascii=False, indent=2)

    ident = preview["identidad_ingesta"]
    print("=== IDENTIDAD DE INGESTA ===", file=sys.stderr)
    print(f"fuente_hash: {ident['fuente_hash']}", file=sys.stderr)
    print(f"perfil_extractor: {ident['perfil_extractor']}", file=sys.stderr)
    print(f"version_pipeline: {ident['version_pipeline']}", file=sys.stderr)
    print(f"scope_solicitado: {json.dumps(ident['scope_solicitado'], ensure_ascii=False)}", file=sys.stderr)
    print(f"scope_hash: {ident['scope_hash']}", file=sys.stderr)
    print(file=sys.stderr)
    print("=== VALIDACIÓN ===", file=sys.stderr)
    print(f"ok: {preview['validacion']['ok']}", file=sys.stderr)
    print(file=sys.stderr)
    print("=== CANDIDATOS ===", file=sys.stderr)
    print(f"total: {preview['total_candidatos']}", file=sys.stderr)
    for tipo, n in sorted(preview["candidatos_por_tipo"].items()):
        print(f"  {tipo}: {n}", file=sys.stderr)


if __name__ == "__main__":
    main()
