"""Normalización conservadora y determinista de texto extraído por
geometría. Nunca corrige ortografía, nunca reescribe, nunca resume, nunca
completa, nunca usa IA. Todo el módulo es texto -> texto, sin ningún
componente de interpretación semántica.

Cada línea de texto llega ya agrupada por posición vertical (una "línea
visual" real del documento, no una línea lógica). La recomposición de
guionado de fin de línea SOLO se aplica cuando la evidencia geométrica lo
confirma: la línea es la penúltima o anterior de un mismo párrafo (nunca la
última línea de un párrafo, que no continúa hacia ningún lado) y termina en
un guion pegado a una letra (nunca un guion con espacio antes, que sería un
guion léxico real, no un corte tipográfico).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

_GUION_FIN_LINEA = re.compile(r"(?<=\w)-$")
_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class ResultadoNormalizacion:
    texto_normalizado: str
    normalizacion_aplicada: tuple


def normalizar_lineas(lineas: list[str]) -> ResultadoNormalizacion:
    """Une una lista de líneas visuales (ya agrupadas por geometría) en un
    único texto normalizado, aplicando solo transformaciones documentadas
    y reversibles."""
    aplicadas: set[str] = set()

    unido = []
    for i, linea in enumerate(lineas):
        es_ultima = i == len(lineas) - 1
        if not es_ultima and _GUION_FIN_LINEA.search(linea):
            # Corte tipográfico de fin de línea confirmado por geometría
            # (esta línea no es la última del párrafo): se une sin espacio
            # y sin el guion.
            unido.append(linea[:-1])
            aplicadas.add("guion_fin_linea")
        else:
            unido.append(linea + (" " if not es_ultima else ""))

    texto = "".join(unido)

    texto_nfc = unicodedata.normalize("NFC", texto)
    if texto_nfc != texto:
        aplicadas.add("nfc_unicode")
        texto = texto_nfc

    colapsado = _WHITESPACE.sub(" ", texto).strip()
    if colapsado != texto:
        aplicadas.add("whitespace_colapsado")

    return ResultadoNormalizacion(
        texto_normalizado=colapsado,
        normalizacion_aplicada=tuple(sorted(aplicadas)),
    )
