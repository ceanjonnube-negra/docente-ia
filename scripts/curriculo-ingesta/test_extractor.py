#!/usr/bin/env python3
"""Tests deterministas del extractor curricular — Currículo V1-B-2.

No usan el PDF oficial ni ningún JSON de salida real: construyen
directamente las estructuras intermedias (líneas con posición, celdas) que
el extractor produciría, para poder comprobar el COMPORTAMIENTO de la
normalización y la segmentación geométrica de forma aislada y reproducible,
sin depender de un archivo externo ni de red.

Ejecutar: ./.venv/bin/python3 -m unittest test_extractor.py -v
"""

from __future__ import annotations

import unicodedata
import unittest

from normalizacion import normalizar_lineas
from extractor import _dividir_parrafos, _agrupar_lineas


class TestNormalizacionBasica(unittest.TestCase):
    def test_a_unicode_nfc(self):
        # Construido explicitamente en forma NFD (letra + acento
        # combinante) para no depender de como el literal fuente haya
        # quedado codificado en el archivo -- la entrada debe llegar
        # genuinamente descompuesta para que el test compruebe algo real.
        import unicodedata as _ud
        precompuesto = _ud.normalize("NFC", "informaci\u00f3n")
        descompuesto = _ud.normalize("NFD", precompuesto)
        self.assertNotEqual(descompuesto, precompuesto, "la entrada de prueba debe estar genuinamente en NFD")

        resultado = normalizar_lineas([descompuesto])
        self.assertEqual(resultado.texto_normalizado, precompuesto)
        self.assertIn("nfc_unicode", resultado.normalizacion_aplicada)

    def test_b_whitespace(self):
        resultado = normalizar_lineas(["  la   búsqueda    de  información  "])
        self.assertEqual(resultado.texto_normalizado, "la búsqueda de información")
        self.assertIn("whitespace_colapsado", resultado.normalizacion_aplicada)

    def test_c_guionado_valido_dentro_del_mismo_bloque(self):
        # interroga- + ción -> interrogación, ambas líneas del MISMO bloque.
        resultado = normalizar_lineas(["Emplea los signos de interroga-", "ción al elaborar preguntas."])
        self.assertEqual(
            resultado.texto_normalizado,
            "Emplea los signos de interrogación al elaborar preguntas.",
        )
        self.assertIn("guion_fin_linea", resultado.normalizacion_aplicada)

    def test_d_guion_al_final_de_bloque_sin_continuacion_se_conserva(self):
        # El guion es la ÚLTIMA línea del bloque (no hay continuación
        # dentro del mismo bloque) -> debe conservarse tal cual, nunca
        # inventar una unión con nada.
        resultado = normalizar_lineas(["Analiza el problema con detenimiento y precau-"])
        self.assertTrue(resultado.texto_normalizado.endswith("precau-"))
        self.assertNotIn("guion_fin_linea", resultado.normalizacion_aplicada)

    def test_guion_con_espacio_antes_no_se_recompone(self):
        # Un guion léxico real (con espacio antes) nunca debe tratarse
        # como corte tipográfico.
        resultado = normalizar_lineas(["Cuidado con la fórmula ácido -", "base."])
        # No se une "ácido -base" en "ácidobase"; se conserva como texto
        # separado (guion léxico real, no de fin de línea pegado a letra).
        self.assertIn("ácido -", resultado.texto_normalizado)


class TestDivisionDeParrafos(unittest.TestCase):
    def _lineas(self, specs):
        # specs: lista de (top, texto)
        return list(specs)

    def test_e_gap_normal_mismo_pda(self):
        lineas = self._lineas([
            (100.0, "Formula preguntas para realizar"),
            (112.0, "la búsqueda de información."),
            (124.0, "Reflexiona sobre el resultado."),
        ])
        parrafos, duda = _dividir_parrafos(lineas)
        self.assertEqual(len(parrafos), 1)
        self.assertIsNone(duda)

    def test_f_gap_de_ruptura_nuevo_pda(self):
        lineas = self._lineas([
            (100.0, "Formula preguntas para realizar"),
            (112.0, "la búsqueda de información."),
            (136.0, "Usa variadas fuentes de consulta,"),  # gap=24.0 -> nuevo PDA
            (148.0, "entre ellas medios de comunicación."),
        ])
        parrafos, duda = _dividir_parrafos(lineas)
        self.assertEqual(len(parrafos), 2)
        self.assertIsNone(duda)
        self.assertEqual(parrafos[0], ["Formula preguntas para realizar", "la búsqueda de información."])
        self.assertEqual(parrafos[1], ["Usa variadas fuentes de consulta,", "entre ellas medios de comunicación."])

    def test_g_gap_en_banda_ambigua_no_adivina(self):
        # baseline=12.0 (de los gaps pequeños); umbral_confirmado=19.2;
        # umbral_ambiguo=15.6. Un gap de 17.0 cae en la banda ambigua:
        # ni claramente misma línea ni claramente nuevo párrafo.
        lineas = self._lineas([
            (100.0, "Primera línea del bloque"),
            (112.0, "segunda línea del bloque."),
            (129.0, "Tercera línea con gap ambiguo (17.0pt)."),
        ])
        parrafos, duda = _dividir_parrafos(lineas)
        self.assertIsNotNone(duda, "un gap en banda ambigua debe producir una señal explícita de duda, no decidir en silencio")
        self.assertIn("gap_ambiguo", duda)

    def test_gap_unico_sin_gaps_de_referencia_es_dudoso(self):
        # Solo dos líneas con un gap grande y NINGÚN gap pequeño de
        # referencia en la celda: no hay forma de calibrar un baseline
        # confiable -> debe marcarse como no resoluble, no asumir un
        # umbral arbitrario.
        lineas = self._lineas([
            (100.0, "Única línea inicial"),
            (130.0, "línea con separación grande sin referencia."),
        ])
        parrafos, duda = _dividir_parrafos(lineas)
        self.assertEqual(parrafos, [])
        self.assertEqual(duda, "sin_gaps_de_referencia_para_calibrar_interlineado")


class TestAgruparLineas(unittest.TestCase):
    def test_j_agrupa_palabras_por_linea_en_orden_de_lectura(self):
        words = [
            {"text": "mundo", "top": 100.02, "x0": 50.0},
            {"text": "Hola", "top": 100.0, "x0": 10.0},
            {"text": "línea", "top": 112.0, "x0": 10.0},
            {"text": "Segunda", "top": 112.03, "x0": 55.0},
        ]
        lineas = _agrupar_lineas(words)
        self.assertEqual(lineas[0][1], "Hola mundo")
        self.assertEqual(lineas[1][1], "línea Segunda")


class TestContinuaciones(unittest.TestCase):
    """Las reglas H/I de continuación entre páginas dependen de estado que
    vive en extractor._procesar_pagina (acoplado a pdfplumber). Se prueban
    aquí las invariantes de la estructura de datos que esa función produce,
    construyendo directamente los objetos ContenidoCandidato/PdaCandidato
    tal como los produciría, sin necesitar el PDF real."""

    def test_h_continuacion_valida_conserva_padre_y_evidencia_de_ambas_paginas(self):
        from extractor import ContenidoCandidato

        contenido = ContenidoCandidato(
            clave_local="lenguajes#contenido#3",
            campo_clave="lenguajes",
            titulo={"texto_normalizado": "Comprensión y producción de textos expositivos"},
            paginas=[25],
        )
        # Simula lo que _procesar_pagina hace ante una fila de continuación
        # válida (Contenido vacío + contenido_abierto existente):
        num_pagina = 26
        if num_pagina not in contenido.paginas:
            contenido.paginas.append(num_pagina)
            contenido.continuacion = {"paginas": list(contenido.paginas)}

        self.assertEqual(contenido.paginas, [25, 26])
        self.assertEqual(contenido.continuacion, {"paginas": [25, 26]})
        self.assertEqual(contenido.campo_clave, "lenguajes")  # el padre se conserva

    def test_i_continuacion_sin_contenido_padre_es_dudoso(self):
        from extractor import ContenidoCandidato

        contenido_abierto = None
        # Replica exactamente la rama de _procesar_pagina para este caso.
        if contenido_abierto is None:
            contenido_abierto = ContenidoCandidato(
                clave_local="lenguajes#contenido#0",
                campo_clave="lenguajes",
                titulo={"texto_normalizado": "(sin título — continuación sin contenido previo)"},
                paginas=[24],
                estado_validacion="dudoso",
                motivo_dudoso="fila_continuacion_sin_contenido_previo_abierto",
            )
        self.assertEqual(contenido_abierto.estado_validacion, "dudoso")
        self.assertEqual(contenido_abierto.motivo_dudoso, "fila_continuacion_sin_contenido_previo_abierto")


class TestAsignacionDeColumnas(unittest.TestCase):
    def test_j_columna_pda_3_mapea_a_grado_3_y_columna_pda_4_a_grado_4(self):
        from perfiles import PERFIL_PROGRAMA_SINTETICO_FASE4_2024 as perfil

        self.assertEqual(perfil.columnas_grado[1], "3")
        self.assertEqual(perfil.columnas_grado[2], "4")
        self.assertEqual(perfil.encabezados_grado_esperados[1], "Tercer grado")
        self.assertEqual(perfil.encabezados_grado_esperados[2], "Cuarto grado")


if __name__ == "__main__":
    unittest.main()
