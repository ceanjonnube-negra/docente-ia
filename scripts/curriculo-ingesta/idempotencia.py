"""Decisión de idempotencia de ejecución — Currículo V1-B-3 (ajustada).

Respeta el índice único parcial ya creado en V1-B-1
(`ingesta_curricular_activa_unica_idx` sobre
`fuente_hash, perfil_extractor, version_pipeline, scope_hash` WHERE
`estado='en_progreso'`).

Diseño en DOS FASES, deliberadamente puro (sin tocar Supabase aquí — eso
es responsabilidad del orquestador en cargar_staging.py):

  1. `decidir_estrategia_preliminar(ingestas_existentes)` — decide, a
     partir SOLO de la lista de ingestas con la misma identidad exacta
     (fuente_hash+perfil_extractor+version_pipeline+scope_hash) y sus
     `estado`, si hace falta leer sus candidatos persistidos antes de
     poder decidir con certeza (`requiere_readback=True`), o si ya se
     puede decidir sin leer nada más (crear_nueva / abortar_conflicto por
     múltiples equivalentes).

  2. `resolver_verificacion_readback(decision_preliminar, persistidos,
     transformados)` — con los candidatos YA leídos de la ingesta
     existente y los candidatos de la transformación actual, decide el
     resultado final. Nunca acepta una ingesta existente solo porque su
     identidad coincide — también debe coincidir su CONTENIDO exacto
     (tipo, clave_local, parent_local, fingerprint, estado_validacion,
     conteo).

Resultado final posible:
  - 'crear_nueva'            -> no existe nada equivalente, escribir todo.
  - 'reutilizar_completada'  -> ya existe una ingesta COMPLETADA idéntica
                                 en contenido -> NO-OP exitoso, 0 writes.
  - 'recuperar_en_progreso'  -> existe una ingesta EN_PROGRESO cuyos
                                 candidatos persistidos ya coinciden
                                 exactamente con los esperados -> puede
                                 marcarse 'completado' de forma segura
                                 (solo el statement 2, nunca re-insertar).
  - 'abortar_conflicto'      -> cualquier discrepancia real, o múltiples
                                 ingestas equivalentes -> 0 writes,
                                 requiere revisión manual.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DecisionReintento:
    estrategia: str
    motivo: str
    ingesta_existente_id: str | None = None
    requiere_readback: bool = False


def _mapa_por_clave_local(candidatos: list[dict]) -> dict:
    return {
        c["clave_local"]: (c["tipo"], c["parent_local"], c["fingerprint"], c["estado_validacion"])
        for c in candidatos
    }


def candidatos_coinciden_exactamente(persistidos: list[dict], transformados: list[dict]) -> tuple[bool, str]:
    """Compara dos listas de candidatos por (tipo, clave_local,
    parent_local, fingerprint, estado_validacion) -- nunca solo por
    conteo de filas. Devuelve (coincide, detalle_legible)."""
    mapa_p = _mapa_por_clave_local(persistidos)
    mapa_t = _mapa_por_clave_local(transformados)

    if len(mapa_p) != len(persistidos):
        return False, "clave_local duplicada entre los candidatos persistidos"
    if len(mapa_t) != len(transformados):
        return False, "clave_local duplicada entre los candidatos transformados (no debería ocurrir tras validar_staging)"

    if mapa_p == mapa_t:
        return True, f"coincidencia exacta ({len(mapa_p)} candidatos)"

    faltantes = set(mapa_t) - set(mapa_p)
    sobrantes = set(mapa_p) - set(mapa_t)
    comunes = set(mapa_p) & set(mapa_t)
    diferentes = {k for k in comunes if mapa_p[k] != mapa_t[k]}

    detalles = []
    if faltantes:
        detalles.append(f"{len(faltantes)} candidatos esperados no están persistidos (p.ej. {sorted(faltantes)[:3]})")
    if sobrantes:
        detalles.append(f"{len(sobrantes)} candidatos persistidos no pertenecen a la transformación actual (p.ej. {sorted(sobrantes)[:3]})")
    if diferentes:
        detalles.append(f"{len(diferentes)} candidatos con tipo/parent_local/fingerprint/estado distinto (p.ej. {sorted(diferentes)[:3]})")
    return False, "; ".join(detalles) if detalles else "discrepancia no clasificada"


def decidir_estrategia_preliminar(ingestas_existentes: list[dict]) -> DecisionReintento:
    if not ingestas_existentes:
        return DecisionReintento("crear_nueva", "no existe ninguna ingesta previa con esta identidad exacta")

    activas = [i for i in ingestas_existentes if i.get("estado") == "en_progreso"]
    completadas = [i for i in ingestas_existentes if i.get("estado") == "completado"]

    total_relevantes = len(activas) + len(completadas)
    if total_relevantes > 1:
        return DecisionReintento(
            "abortar_conflicto",
            f"existen {total_relevantes} ingestas equivalentes activas/completadas con la misma identidad "
            f"-- estado ambiguo, nunca se adivina cuál usar, requiere revisión manual",
        )

    if len(completadas) == 1:
        return DecisionReintento(
            "pendiente_verificacion_completada",
            "existe 1 ingesta completada con esta identidad -- requiere read-back de sus candidatos "
            "para confirmar coincidencia exacta antes de decidir (identidad coincidente no es suficiente)",
            ingesta_existente_id=completadas[0]["id"],
            requiere_readback=True,
        )

    if len(activas) == 1:
        return DecisionReintento(
            "pendiente_verificacion_en_progreso",
            "existe 1 ingesta en_progreso con esta identidad -- requiere read-back para confirmar si "
            "ya tiene exactamente los candidatos esperados (recuperable) o está parcial (abortar)",
            ingesta_existente_id=activas[0]["id"],
            requiere_readback=True,
        )

    # Únicamente fallido/descartado -- identidad libre para reintentar.
    return DecisionReintento("crear_nueva", "las ingestas previas con esta identidad terminaron en fallido/descartado -- libre para reintentar")


def resolver_verificacion_readback(
    decision_preliminar: DecisionReintento,
    persistidos: list[dict],
    transformados: list[dict],
) -> DecisionReintento:
    if not decision_preliminar.requiere_readback:
        raise ValueError(f"decisión preliminar '{decision_preliminar.estrategia}' no requería read-back")

    coincide, detalle = candidatos_coinciden_exactamente(persistidos, transformados)

    if decision_preliminar.estrategia == "pendiente_verificacion_completada":
        if coincide:
            return DecisionReintento(
                "reutilizar_completada",
                f"ingesta completada ya existente coincide exactamente con la transformación actual ({detalle}) -- no-op seguro",
                ingesta_existente_id=decision_preliminar.ingesta_existente_id,
            )
        return DecisionReintento(
            "abortar_conflicto",
            f"ingesta completada existente NO coincide con la transformación actual: {detalle}",
            ingesta_existente_id=decision_preliminar.ingesta_existente_id,
        )

    if decision_preliminar.estrategia == "pendiente_verificacion_en_progreso":
        if coincide:
            return DecisionReintento(
                "recuperar_en_progreso",
                f"ingesta en_progreso ya tiene exactamente los candidatos esperados ({detalle}) -- "
                f"se puede marcar completada de forma segura, nunca reinsertar",
                ingesta_existente_id=decision_preliminar.ingesta_existente_id,
            )
        return DecisionReintento(
            "abortar_conflicto",
            f"ingesta en_progreso existente está parcial o difiere de lo esperado: {detalle} -- "
            f"no se inserta encima, no se borra automáticamente",
            ingesta_existente_id=decision_preliminar.ingesta_existente_id,
        )

    raise ValueError(f"decisión preliminar inesperada: {decision_preliminar.estrategia}")
