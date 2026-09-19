#!/usr/bin/env python3
"""Extractor determinista — Currículo V1-B-2.

PDF oficial -> extracción geométrica (coordenadas) -> campo formativo ->
contenido -> PDA individual -> grado -> evidencia exacta.

0 llamadas a IA. 0 OCR. Toda decisión estructural es determinista y basada
en geometría/layout real del PDF (posición de palabras, detección de tablas
por coordenadas, distribución observada de separaciones entre líneas).
Cuando una celda no puede dividirse de forma inequívoca, se marca DUDOSO —
nunca se adivina, nunca se completa, nunca se corrige semánticamente.

Esta herramienta NO escribe en Supabase. Produce exclusivamente una
estructura JSON en archivo local, para revisión antes de cualquier
transformación a candidatos de staging (microfase posterior).

Uso:
    ./.venv/bin/python3 extractor.py --pdf <ruta.pdf> --salida <salida.json>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field

import pdfplumber

from normalizacion import normalizar_lineas
from perfiles import PERFIL_PROGRAMA_SINTETICO_FASE4_2024, CampoPerfil, PerfilExtraccion

VERSION_PIPELINE = "0.1.0"

# --- calibración de separación de párrafos dentro de una celda ---
# No es un valor fijo ciego: se calibra por celda a partir de la
# distribución real de separaciones entre líneas observadas en ESA celda
# (interlineado normal = moda de los gaps pequeños). Un gap por encima del
# umbral confirmado se trata como límite real entre PDA distintos; un gap
# en la banda ambigua marca la celda como DUDOSA en vez de decidir a
# ciegas.
GAP_NORMAL_MAXIMO = 18.0  # por debajo de esto, nunca es un salto de párrafo
UMBRAL_CONFIRMADO_FACTOR = 1.6
UMBRAL_AMBIGUO_FACTOR = 1.3


@dataclass
class Evidencia:
    pagina: int
    top: float
    bottom: float
    fragmento_local: str


@dataclass
class TextoConEvidencia:
    texto_original: str
    texto_normalizado: str
    normalizacion_aplicada: list
    evidencia: dict


@dataclass
class PdaCandidato:
    clave_local: str
    grado: str
    texto: dict
    estado_validacion: str
    motivo_dudoso: str | None = None


@dataclass
class ContenidoCandidato:
    clave_local: str
    campo_clave: str
    titulo: dict
    pda: list = field(default_factory=list)
    paginas: list = field(default_factory=list)
    continuacion: dict | None = None
    estado_validacion: str = "confirmado"
    motivo_dudoso: str | None = None


class Reporte:
    def __init__(self):
        self.paginas_procesadas: list[int] = []
        self.tablas_detectadas = 0
        self.contenidos_detectados = 0
        self.pda_3_detectados = 0
        self.pda_4_detectados = 0
        self.continuaciones_detectadas = 0
        self.dudosos = 0
        self.errores: list[str] = []
        self.celdas_sin_asignar: list[dict] = []
        self.paginas_estructura_inesperada: list[dict] = []

    def to_dict(self, campos_detectados: int):
        return {
            "paginas_procesadas": self.paginas_procesadas,
            "tablas_detectadas": self.tablas_detectadas,
            "campos_detectados": campos_detectados,
            "contenidos_detectados": self.contenidos_detectados,
            "pda_3_detectados": self.pda_3_detectados,
            "pda_4_detectados": self.pda_4_detectados,
            "continuaciones_detectadas": self.continuaciones_detectadas,
            "dudosos": self.dudosos,
            "errores": self.errores,
            "celdas_sin_asignar": self.celdas_sin_asignar,
            "paginas_estructura_inesperada": self.paginas_estructura_inesperada,
        }


def calcular_sha256(ruta: str) -> str:
    h = hashlib.sha256()
    with open(ruta, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def _agrupar_lineas(words: list[dict]) -> list[tuple[float, str]]:
    """Agrupa palabras (con posición) en líneas visuales reales por su
    coordenada 'top', preservando el orden de lectura x0 dentro de cada
    línea. Devuelve [(top, texto_de_la_linea), ...] ordenado por top."""
    lineas: dict[float, list[dict]] = {}
    for w in words:
        clave = round(w["top"], 1)
        lineas.setdefault(clave, []).append(w)
    resultado = []
    for top in sorted(lineas.keys()):
        palabras_ordenadas = sorted(lineas[top], key=lambda w: w["x0"])
        texto = " ".join(w["text"] for w in palabras_ordenadas)
        resultado.append((top, texto))
    return resultado


def _dividir_parrafos(lineas: list[tuple[float, str]]) -> tuple[list[list[str]], str | None]:
    """Divide las líneas de una celda en párrafos (cada uno = un PDA
    candidato) usando la distribución real de separaciones verticales.
    Devuelve (parrafos, motivo_dudoso_o_None)."""
    if not lineas:
        return [], None

    tops = [t for t, _ in lineas]
    gaps = [round(tops[i] - tops[i - 1], 1) for i in range(1, len(tops))]

    if not gaps:
        return [[lineas[0][1]]], None

    pequenos = [g for g in gaps if g < GAP_NORMAL_MAXIMO]
    if not pequenos:
        return [], "sin_gaps_de_referencia_para_calibrar_interlineado"

    baseline = Counter(pequenos).most_common(1)[0][0]
    umbral_confirmado = baseline * UMBRAL_CONFIRMADO_FACTOR
    umbral_ambiguo = baseline * UMBRAL_AMBIGUO_FACTOR

    parrafos: list[list[str]] = [[lineas[0][1]]]
    duda = None
    for gap, (_, texto) in zip(gaps, lineas[1:]):
        if gap > umbral_confirmado:
            parrafos.append([texto])
        elif gap > umbral_ambiguo:
            duda = f"gap_ambiguo={gap}_baseline={baseline}_pt"
            parrafos.append([texto])
        else:
            parrafos[-1].append(texto)

    return parrafos, duda


def _texto_con_evidencia(lineas_texto: list[str], pagina: int, top: float, bottom: float, frag: str) -> dict:
    norm = normalizar_lineas(lineas_texto)
    texto_original = "\n".join(lineas_texto)
    return asdict(
        TextoConEvidencia(
            texto_original=texto_original,
            texto_normalizado=norm.texto_normalizado,
            normalizacion_aplicada=list(norm.normalizacion_aplicada),
            evidencia=asdict(Evidencia(pagina=pagina, top=round(top, 1), bottom=round(bottom, 1), fragmento_local=frag)),
        )
    )


def _extraer_celda_pda(page, bbox, pagina: int, grado: str, clave_local_base: str, reporte: Reporte):
    """Devuelve (lista[PdaCandidato], hubo_texto: bool)."""
    x0, top, x1, bottom = bbox
    crop = page.within_bbox(bbox)
    words = crop.extract_words()
    lineas = _agrupar_lineas(words)
    if not lineas:
        return [], False

    parrafos, duda_celda = _dividir_parrafos(lineas)
    if not parrafos:
        reporte.celdas_sin_asignar.append(
            {"pagina": pagina, "bbox": [round(v, 1) for v in bbox], "motivo": duda_celda or "sin_parrafos"}
        )
        return [], True

    candidatos = []
    for i, parrafo in enumerate(parrafos):
        frag = f"pagina-{pagina}"
        texto = _texto_con_evidencia(parrafo, pagina, top, bottom, frag)
        estado = "dudoso" if duda_celda else "confirmado"
        candidatos.append(
            PdaCandidato(
                clave_local=f"{clave_local_base}#pda#{grado}#{i}",
                grado=grado,
                texto=texto,
                estado_validacion=estado,
                motivo_dudoso=duda_celda,
            )
        )
    return candidatos, True


def _procesar_pagina(
    pdf: "pdfplumber.PDF",
    num_pagina: int,
    campo: CampoPerfil,
    perfil: PerfilExtraccion,
    contenido_abierto: ContenidoCandidato | None,
    contador_contenido: list,
    reporte: Reporte,
) -> tuple[list[ContenidoCandidato], ContenidoCandidato | None]:
    page = pdf.pages[num_pagina - 1]
    reporte.paginas_procesadas.append(num_pagina)

    tablas = page.find_tables()
    if len(tablas) != 1:
        reporte.paginas_estructura_inesperada.append(
            {"pagina": num_pagina, "motivo": f"se esperaba 1 tabla, se encontraron {len(tablas)}"}
        )
        reporte.errores.append(f"pagina {num_pagina}: {len(tablas)} tablas detectadas (se esperaba 1)")
        return [], contenido_abierto

    tabla = tablas[0]
    datos = tabla.extract()
    if not datos or len(datos[0]) != 3:
        ncols = len(datos[0]) if datos else 0
        reporte.paginas_estructura_inesperada.append(
            {"pagina": num_pagina, "motivo": f"se esperaban 3 columnas, se encontraron {ncols}"}
        )
        reporte.errores.append(f"pagina {num_pagina}: tabla con {ncols} columnas (se esperaban 3)")
        return [], contenido_abierto

    reporte.tablas_detectadas += 1

    # Verificación del encabezado de grado (fila índice 1: [None, 'Tercer
    # grado', 'Cuarto grado']) contra lo declarado en el perfil — nunca se
    # asume el mapeo columna->grado solo por posición sin esta verificación.
    fila_encabezado = datos[1] if len(datos) > 1 else None
    encabezado_ok = True
    if fila_encabezado is None:
        encabezado_ok = False
    else:
        for idx_col, texto_esperado in perfil.encabezados_grado_esperados.items():
            celda = (fila_encabezado[idx_col] or "").replace("\n", " ").strip()
            if texto_esperado not in celda:
                encabezado_ok = False
    if not encabezado_ok:
        reporte.paginas_estructura_inesperada.append(
            {"pagina": num_pagina, "motivo": "encabezado de grado no coincide con el perfil", "fila": fila_encabezado}
        )
        reporte.errores.append(f"pagina {num_pagina}: encabezado de columnas de grado no coincide con el perfil declarado")
        # No abortamos la página completa: seguimos extrayendo con la
        # verificación fallida ya reportada explícitamente (regla: ninguna
        # anomalía se omite, pero tampoco desaparece la página entera si
        # los datos son recuperables).

    contenidos_nuevos: list[ContenidoCandidato] = []
    filas_datos = tabla.rows[2:]  # las 2 primeras filas son encabezado

    for fila in filas_datos:
        celdas = fila.cells
        if len(celdas) != 3 or any(c is None for c in celdas):
            reporte.celdas_sin_asignar.append({"pagina": num_pagina, "motivo": "fila con celda nula", "celdas": celdas})
            continue

        bbox_contenido, bbox_g3, bbox_g4 = celdas

        crop_contenido = page.within_bbox(bbox_contenido)
        lineas_contenido = _agrupar_lineas(crop_contenido.extract_words())
        contenido_vacio = len(lineas_contenido) == 0

        if contenido_vacio:
            # Continuación: solo válida si hay un contenido abierto de la
            # MISMA ejecución de campo (misma página o página
            # inmediatamente anterior dentro del mismo rango de campo).
            if contenido_abierto is None:
                # No hay contexto previo válido -> no se adivina.
                contenido_abierto = ContenidoCandidato(
                    clave_local=f"{campo.clave}#contenido#{len(contador_contenido)}",
                    campo_clave=campo.clave,
                    titulo=_texto_con_evidencia(["(sin título — continuación sin contenido previo)"], num_pagina, bbox_contenido[1], bbox_contenido[3], f"pagina-{num_pagina}"),
                    paginas=[num_pagina],
                    estado_validacion="dudoso",
                    motivo_dudoso="fila_continuacion_sin_contenido_previo_abierto",
                )
                contador_contenido.append(1)
                contenidos_nuevos.append(contenido_abierto)
                reporte.contenidos_detectados += 1
                reporte.dudosos += 1
            else:
                if num_pagina not in contenido_abierto.paginas:
                    contenido_abierto.paginas.append(num_pagina)
                    contenido_abierto.continuacion = {"paginas": list(contenido_abierto.paginas)}
                    reporte.continuaciones_detectadas += 1
        else:
            # Misma protección que en las celdas de PDA: si el título
            # tuviera internamente más de un párrafo (frontera geométrica
            # real, gap > umbral confirmado), nunca se concatenan sus
            # líneas como si fueran un solo bloque continuo — eso podría
            # recomponer un guion de fin de línea atravesando esa
            # frontera. Se toma el primer párrafo como título y se marca
            # DUDOSO para revisión humana en vez de adivinar. En los 85
            # contenidos reales de Fase 4 esto nunca ocurre (título de un
            # solo párrafo en el 100% de los casos, verificado), así que
            # este camino no altera ningún resultado ya validado.
            parrafos_titulo, duda_titulo = _dividir_parrafos(lineas_contenido)
            estado_titulo = "confirmado"
            motivo_titulo = None
            if len(parrafos_titulo) > 1:
                estado_titulo = "dudoso"
                motivo_titulo = f"titulo_con_multiples_parrafos({len(parrafos_titulo)})"
                reporte.dudosos += 1
            texto_titulo = _texto_con_evidencia(
                parrafos_titulo[0] if parrafos_titulo else [t for _, t in lineas_contenido],
                num_pagina, bbox_contenido[1], bbox_contenido[3], f"pagina-{num_pagina}",
            )
            contenido_abierto = ContenidoCandidato(
                clave_local=f"{campo.clave}#contenido#{len(contador_contenido)}",
                campo_clave=campo.clave,
                titulo=texto_titulo,
                paginas=[num_pagina],
                estado_validacion=estado_titulo,
                motivo_dudoso=motivo_titulo,
            )
            contador_contenido.append(1)
            contenidos_nuevos.append(contenido_abierto)
            reporte.contenidos_detectados += 1

        clave_base = contenido_abierto.clave_local
        pda_3, _ = _extraer_celda_pda(page, bbox_g3, num_pagina, "3", clave_base, reporte)
        pda_4, _ = _extraer_celda_pda(page, bbox_g4, num_pagina, "4", clave_base, reporte)

        contenido_abierto.pda.extend(pda_3)
        contenido_abierto.pda.extend(pda_4)
        reporte.pda_3_detectados += len(pda_3)
        reporte.pda_4_detectados += len(pda_4)
        reporte.dudosos += sum(1 for p in pda_3 + pda_4 if p.estado_validacion == "dudoso")

    return contenidos_nuevos, contenido_abierto


def extraer(pdf_path: str, perfil: PerfilExtraccion) -> dict:
    reporte = Reporte()
    campos_salida = []

    with pdfplumber.open(pdf_path) as pdf:
        paginas_totales = len(pdf.pages)

        for campo in perfil.campos:
            contenido_abierto: ContenidoCandidato | None = None
            contador_contenido: list = []
            contenidos_campo: list[ContenidoCandidato] = []

            for num_pagina in range(campo.pagina_inicio, campo.pagina_fin + 1):
                nuevos, contenido_abierto = _procesar_pagina(
                    pdf, num_pagina, campo, perfil, contenido_abierto, contador_contenido, reporte
                )
                contenidos_campo.extend(nuevos)

            campos_salida.append(
                {
                    "clave": campo.clave,
                    "nombre": campo.nombre,
                    "paginas": [campo.pagina_inicio, campo.pagina_fin],
                    "contenidos": [asdict(c) for c in contenidos_campo],
                }
            )

    return {
        "perfil_extractor": perfil.id,
        "version_perfil": perfil.version_perfil,
        "version_pipeline": VERSION_PIPELINE,
        "fuente": {
            "archivo": pdf_path.split("/")[-1],
            "sha256": calcular_sha256(pdf_path),
            "paginas_totales": paginas_totales,
            "organismo": perfil.organismo,
            "titulo_documento": perfil.titulo_documento,
            "version_edicion": perfil.version_edicion,
        },
        "scope": {
            "nivel_educativo": perfil.nivel_educativo,
            "fase_clave": perfil.fase_clave,
            "campos": [c.clave for c in perfil.campos],
            "grados": sorted(set(perfil.columnas_grado.values())),
        },
        "campos": campos_salida,
        "reporte": reporte.to_dict(campos_detectados=len(campos_salida)),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pdf", required=True, help="Ruta local al PDF oficial (nunca se commitea)")
    ap.add_argument("--salida", required=True, help="Ruta de salida del JSON (nunca se commitea)")
    args = ap.parse_args()

    resultado = extraer(args.pdf, PERFIL_PROGRAMA_SINTETICO_FASE4_2024)

    with open(args.salida, "w", encoding="utf-8") as f:
        json.dump(resultado, f, ensure_ascii=False, indent=2)

    r = resultado["reporte"]
    print(f"SHA-256 fuente: {resultado['fuente']['sha256']}", file=sys.stderr)
    print(f"Páginas totales del PDF: {resultado['fuente']['paginas_totales']}", file=sys.stderr)
    print(f"Páginas procesadas: {len(r['paginas_procesadas'])}", file=sys.stderr)
    print(f"Tablas detectadas: {r['tablas_detectadas']}", file=sys.stderr)
    print(f"Campos detectados: {r['campos_detectados']}", file=sys.stderr)
    print(f"Contenidos detectados: {r['contenidos_detectados']}", file=sys.stderr)
    print(f"PDA 3°: {r['pda_3_detectados']}  PDA 4°: {r['pda_4_detectados']}", file=sys.stderr)
    print(f"Continuaciones: {r['continuaciones_detectadas']}", file=sys.stderr)
    print(f"Dudosos: {r['dudosos']}", file=sys.stderr)
    print(f"Errores: {len(r['errores'])}", file=sys.stderr)
    print(f"Celdas sin asignar: {len(r['celdas_sin_asignar'])}", file=sys.stderr)
    print(f"Páginas con estructura inesperada: {len(r['paginas_estructura_inesperada'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
