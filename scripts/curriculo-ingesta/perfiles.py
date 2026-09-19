"""Perfiles de extracción — describen el FORMATO DOCUMENTAL observado de un
documento oficial concreto, como datos de configuración, nunca como lógica
dispersa en el motor de extracción (extractor.py). Un documento de otra
fase/edición se soporta agregando un perfil nuevo, sin tocar el extractor.

Este archivo contiene exclusivamente el perfil verificado contra el PDF
oficial real de "Programa de Estudio para la Educación Primaria: Programa
Sintético de la Fase 4" (SEP, primera edición 2024,
https://educacionbasica.sep.gob.mx/wp-content/uploads/2024/06/Programa_Sintetico_Fase_4.pdf),
según la inspección geométrica realizada en la ronda de diseño previa.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class CampoPerfil:
    clave: str
    nombre: str
    # Rango de páginas (1-indexed, inclusivo) donde vive la tabla real de
    # Contenidos+PDA de este campo formativo — confirmado por inspección
    # directa, NUNCA por el índice del documento (que es solo prosa, no
    # fuente estructural).
    pagina_inicio: int
    pagina_fin: int


@dataclass(frozen=True)
class PerfilExtraccion:
    id: str
    version_perfil: str
    organismo: str
    titulo_documento: str
    version_edicion: str
    nivel_educativo: str
    fase_clave: str
    fase_nombre: str
    # Índice de columna de la tabla (0-indexed) -> clave de grado. La
    # columna 0 siempre es "Contenido" en este perfil, nunca un grado.
    columnas_grado: dict = field(default_factory=dict)
    # Texto de encabezado esperado en cada columna de grado, tal como
    # aparece literalmente en la fila de encabezado de la tabla — se usa
    # para VERIFICAR el mapeo columna->grado en cada página, nunca se
    # asume solo por posición.
    encabezados_grado_esperados: dict = field(default_factory=dict)
    campos: tuple = ()


PERFIL_PROGRAMA_SINTETICO_FASE4_2024 = PerfilExtraccion(
    id="programa_sintetico_fase4_2024",
    version_perfil="1.0.0",
    organismo="SEP",
    titulo_documento=(
        "Programa de Estudio para la Educación Primaria: "
        "Programa Sintético de la Fase 4"
    ),
    version_edicion="Primera edición, 2024",
    nivel_educativo="primaria",
    fase_clave="fase_4",
    fase_nombre="Fase 4",
    columnas_grado={1: "3", 2: "4"},
    encabezados_grado_esperados={1: "Tercer grado", 2: "Cuarto grado"},
    campos=(
        CampoPerfil("lenguajes", "Lenguajes", 24, 36),
        CampoPerfil(
            "saberes_pensamiento_cientifico",
            "Saberes y Pensamiento Científico",
            42, 51,
        ),
        CampoPerfil(
            "etica_naturaleza_sociedades",
            "Ética, Naturaleza y Sociedades",
            56, 66,
        ),
        CampoPerfil(
            "lo_humano_lo_comunitario",
            "De lo Humano y lo Comunitario",
            72, 76,
        ),
    ),
)
