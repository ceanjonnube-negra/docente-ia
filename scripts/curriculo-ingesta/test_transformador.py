#!/usr/bin/env python3
"""Tests deterministas de la transformación extractor -> staging —
Currículo V1-B-3A. No usan el PDF oficial ni Supabase: construyen
directamente una extracción sintética mínima con la misma FORMA exacta
que produce extractor.py, para poder comprobar el comportamiento de
transformador.py e idempotencia.py de forma aislada y reproducible.

Ejecutar: ./.venv/bin/python3 -m unittest test_transformador.py -v
"""

from __future__ import annotations

import copy
import unittest

from transformador import (
    ErrorValidacionStaging,
    calcular_scope_hash,
    construir_identidad_ingesta,
    construir_scope_canonico,
    transformar_candidatos,
    validar_staging,
    verificar_invariantes_conocidos,
)


def _texto(original: str, normalizado: str, pagina: int = 26) -> dict:
    return {
        "texto_original": original,
        "texto_normalizado": normalizado,
        "normalizacion_aplicada": [],
        "evidencia": {"pagina": pagina, "top": 100.0, "bottom": 120.0, "fragmento_local": f"pagina-{pagina}"},
    }


def _extraccion_minima_valida() -> dict:
    """Una extracción sintética con exactamente la forma de extractor.py,
    con 1 campo, 2 contenidos (uno de ellos con continuación entre
    páginas), y PDA de 3° y 4° — deliberadamente pequeña para que los
    tests sean legibles, NO para simular los conteos reales de Fase 4
    (esos se cubren aparte con datos reales, no aquí)."""
    return {
        "perfil_extractor": "perfil_test",
        "version_perfil": "1.0.0",
        "version_pipeline": "0.1.0",
        "fuente": {
            "archivo": "test.pdf",
            "sha256": "abc123",
            "paginas_totales": 10,
            "organismo": "SEP",
            "titulo_documento": "Documento de prueba",
            "version_edicion": "edición de prueba",
        },
        "scope": {
            "nivel_educativo": "primaria",
            "fase_clave": "fase_4",
            "campos": ["lenguajes"],
            "grados": ["4", "3"],  # deliberadamente sin ordenar, para probar la canonicalización
        },
        "campos": [
            {
                "clave": "lenguajes",
                "nombre": "Lenguajes",
                "paginas": [24, 25],
                "contenidos": [
                    {
                        "clave_local": "lenguajes#contenido#0",
                        "campo_clave": "lenguajes",
                        "titulo": _texto("Narracion de sucesos", "Narración de sucesos"),
                        "pda": [
                            {
                                "clave_local": "lenguajes#contenido#0#pda#3#0",
                                "grado": "3",
                                "texto": _texto("Identifica hechos.", "Identifica hechos."),
                                "estado_validacion": "confirmado",
                                "motivo_dudoso": None,
                            },
                            {
                                "clave_local": "lenguajes#contenido#0#pda#4#0",
                                "grado": "4",
                                "texto": _texto("Describe hechos con detalle.", "Describe hechos con detalle."),
                                "estado_validacion": "confirmado",
                                "motivo_dudoso": None,
                            },
                        ],
                        "paginas": [24],
                        "continuacion": None,
                        "estado_validacion": "confirmado",
                        "motivo_dudoso": None,
                    },
                    {
                        "clave_local": "lenguajes#contenido#1",
                        "campo_clave": "lenguajes",
                        "titulo": _texto("Comprension de textos", "Comprensión de textos"),
                        "pda": [
                            {
                                "clave_local": "lenguajes#contenido#1#pda#3#0",
                                "grado": "3",
                                "texto": _texto("Lee en voz alta.", "Lee en voz alta."),
                                "estado_validacion": "confirmado",
                                "motivo_dudoso": None,
                            },
                        ],
                        "paginas": [24, 25],
                        "continuacion": {"paginas": [24, 25]},
                        "estado_validacion": "confirmado",
                        "motivo_dudoso": None,
                    },
                ],
            },
        ],
        "reporte": {
            "paginas_procesadas": [24, 25],
            "tablas_detectadas": 2,
            "campos_detectados": 1,
            "contenidos_detectados": 2,
            "pda_3_detectados": 2,
            "pda_4_detectados": 1,
            "continuaciones_detectadas": 1,
            "dudosos": 0,
            "errores": [],
            "celdas_sin_asignar": [],
            "paginas_estructura_inesperada": [],
        },
    }


class TestScope(unittest.TestCase):
    def test_scope_canonico_ordena_y_dedup(self):
        extraccion = _extraccion_minima_valida()
        scope = construir_scope_canonico(extraccion)
        self.assertEqual(scope["grados"], ["3", "4"])  # ordenado, aunque la entrada estaba ["4","3"]
        self.assertEqual(scope["campos"], ["lenguajes"])

    def test_scope_hash_es_determinista(self):
        extraccion = _extraccion_minima_valida()
        scope1 = construir_scope_canonico(extraccion)
        scope2 = construir_scope_canonico(copy.deepcopy(extraccion))
        self.assertEqual(calcular_scope_hash(scope1), calcular_scope_hash(scope2))

    def test_scope_hash_no_depende_del_grupo_docente(self):
        # El scope canónico no tiene ningún campo relacionado a docente,
        # grupo o "4°B" — solo nivel/fase/grados/campos curriculares.
        extraccion = _extraccion_minima_valida()
        scope = construir_scope_canonico(extraccion)
        self.assertNotIn("grupo", scope)
        self.assertNotIn("docente", scope)
        self.assertEqual(set(scope.keys()), {"nivel_educativo", "fase_clave", "grados", "campos"})


class TestIdentidadIngesta(unittest.TestCase):
    def test_usa_fuente_hash_real_del_extractor(self):
        extraccion = _extraccion_minima_valida()
        identidad = construir_identidad_ingesta(extraccion)
        self.assertEqual(identidad["fuente_hash"], "abc123")
        self.assertEqual(identidad["perfil_extractor"], "perfil_test")
        self.assertIn("extractor:0.1.0", identidad["version_pipeline"])
        self.assertIn("transformador:", identidad["version_pipeline"])


class TestTransformacion(unittest.TestCase):
    def test_no_duplica_contenido_por_grado(self):
        extraccion = _extraccion_minima_valida()
        candidatos = transformar_candidatos(extraccion)
        contenidos = [c for c in candidatos if c["tipo"] == "contenido"]
        # 2 contenidos en la entrada -> exactamente 2 candidatos contenido,
        # sin importar que el segundo tenga solo PDA de 3° y el primero
        # tenga PDA de ambos grados.
        self.assertEqual(len(contenidos), 2)

    def test_relaciones_campo_contenido_pda_pda_grado(self):
        extraccion = _extraccion_minima_valida()
        candidatos = transformar_candidatos(extraccion)
        por_tipo = {t: [c for c in candidatos if c["tipo"] == t] for t in ("campo", "contenido", "pda", "pda_grado")}

        self.assertEqual(len(por_tipo["campo"]), 1)
        self.assertEqual(len(por_tipo["contenido"]), 2)
        self.assertEqual(len(por_tipo["pda"]), 3)  # 2 en el primer contenido + 1 en el segundo
        self.assertEqual(len(por_tipo["pda_grado"]), 3)  # 1 a 1 con cada pda en este documento

        clave_campo = por_tipo["campo"][0]["clave_local"]
        for contenido in por_tipo["contenido"]:
            self.assertEqual(contenido["parent_local"], clave_campo)

        claves_contenido = {c["clave_local"] for c in por_tipo["contenido"]}
        for pda in por_tipo["pda"]:
            self.assertIn(pda["parent_local"], claves_contenido)

        claves_pda = {c["clave_local"] for c in por_tipo["pda"]}
        for rel in por_tipo["pda_grado"]:
            self.assertIn(rel["parent_local"], claves_pda)
            self.assertIn(rel["payload"]["grado_clave"], ("3", "4"))

    def test_claves_locales_no_colisionan_cuando_extractor_reutiliza_indice(self):
        # Regresión del defecto real encontrado en la corrida completa
        # contra Fase 4: un contenido con continuación entre páginas
        # (25->26) acumula PDA de DOS llamadas de extracción distintas, y
        # el clave_local que el EXTRACTOR les da colisiona porque cada
        # llamada reinicia su índice en 0 (p. ej. dos PDA con el mismo
        # "...#pda#3#0" embebido). La transformación debe seguir
        # produciendo claves de staging únicas de todas formas, porque
        # deriva la clave de la posición global en la lista ya aplanada,
        # no del clave_local embebido por el extractor.
        extraccion = _extraccion_minima_valida()
        contenido0 = extraccion["campos"][0]["contenidos"][0]
        # Duplica deliberadamente el clave_local embebido del primer PDA
        # (simula exactamente la colisión real observada).
        pda_colisionado = copy.deepcopy(contenido0["pda"][0])
        contenido0["pda"].append(pda_colisionado)

        candidatos = transformar_candidatos(extraccion)
        claves = [c["clave_local"] for c in candidatos]
        self.assertEqual(len(claves), len(set(claves)), "no debe haber ninguna clave_local de staging duplicada")
        # Y aun así debe seguir siendo válido para el validador fail-closed.
        resultado = validar_staging(extraccion, candidatos)
        self.assertTrue(resultado["ok"])

    def test_claves_locales_deterministas_entre_corridas(self):
        extraccion = _extraccion_minima_valida()
        c1 = transformar_candidatos(extraccion)
        c2 = transformar_candidatos(copy.deepcopy(extraccion))
        claves1 = [c["clave_local"] for c in c1]
        claves2 = [c["clave_local"] for c in c2]
        self.assertEqual(claves1, claves2)

    def test_evidencia_preserva_texto_original_y_normalizado(self):
        extraccion = _extraccion_minima_valida()
        candidatos = transformar_candidatos(extraccion)
        contenido0 = next(c for c in candidatos if c["clave_local"] == "contenido:lenguajes#contenido#0")
        self.assertEqual(contenido0["payload"]["titulo"], "Narración de sucesos")
        self.assertEqual(contenido0["evidencia"]["texto_original"], "Narracion de sucesos")
        self.assertIn("pagina", contenido0["evidencia"])

    def test_continuacion_se_conserva_en_evidencia(self):
        extraccion = _extraccion_minima_valida()
        candidatos = transformar_candidatos(extraccion)
        contenido1 = next(c for c in candidatos if c["clave_local"] == "contenido:lenguajes#contenido#1")
        self.assertEqual(contenido1["evidencia"]["continuacion"], {"paginas": [24, 25]})
        self.assertEqual(contenido1["evidencia"]["paginas"], [24, 25])


class TestValidacionFailClosed(unittest.TestCase):
    def test_extraccion_valida_pasa(self):
        extraccion = _extraccion_minima_valida()
        candidatos = transformar_candidatos(extraccion)
        resultado = validar_staging(extraccion, candidatos)
        self.assertTrue(resultado["ok"])

    def test_dudoso_bloquea_staging(self):
        extraccion = _extraccion_minima_valida()
        extraccion["campos"][0]["contenidos"][0]["estado_validacion"] = "dudoso"
        extraccion["reporte"]["dudosos"] = 1
        candidatos = transformar_candidatos(extraccion)
        with self.assertRaises(ErrorValidacionStaging):
            validar_staging(extraccion, candidatos)

    def test_error_del_extractor_bloquea_staging(self):
        extraccion = _extraccion_minima_valida()
        extraccion["reporte"]["errores"] = ["algo salió mal en la página 30"]
        candidatos = transformar_candidatos(extraccion)
        with self.assertRaises(ErrorValidacionStaging):
            validar_staging(extraccion, candidatos)

    def test_clave_local_duplicada_bloquea_staging(self):
        extraccion = _extraccion_minima_valida()
        candidatos = transformar_candidatos(extraccion)
        candidatos.append(dict(candidatos[0]))  # duplica el primer candidato
        with self.assertRaises(ErrorValidacionStaging):
            validar_staging(extraccion, candidatos)

    def test_referencia_padre_inexistente_bloquea_staging(self):
        extraccion = _extraccion_minima_valida()
        candidatos = transformar_candidatos(extraccion)
        candidatos[2]["parent_local"] = "contenido:no-existe"
        with self.assertRaises(ErrorValidacionStaging):
            validar_staging(extraccion, candidatos)

    def test_pda_sin_relacion_pda_grado_bloquea_staging(self):
        extraccion = _extraccion_minima_valida()
        candidatos = transformar_candidatos(extraccion)
        primer_pda_grado = next(c["clave_local"] for c in candidatos if c["tipo"] == "pda_grado")
        candidatos = [c for c in candidatos if c["clave_local"] != primer_pda_grado]
        with self.assertRaises(ErrorValidacionStaging):
            validar_staging(extraccion, candidatos)


class TestInvariantesConocidos(unittest.TestCase):
    def test_sin_discrepancias_cuando_coincide(self):
        reporte = {"campos_detectados": 4, "contenidos_detectados": 85}
        self.assertEqual(verificar_invariantes_conocidos(reporte, {"campos_detectados": 4, "contenidos_detectados": 85}), [])

    def test_reporta_discrepancia_explicita(self):
        reporte = {"campos_detectados": 3}
        discrepancias = verificar_invariantes_conocidos(reporte, {"campos_detectados": 4})
        self.assertEqual(len(discrepancias), 1)
        self.assertIn("campos_detectados=3", discrepancias[0])
        self.assertIn("esperado 4", discrepancias[0])

    def test_es_agnostico_de_perfil_no_esta_hardcodeado_en_validar_staging(self):
        # Una extraccion minima (1 campo, 2 contenidos) NO debe fallar
        # validar_staging por no tener 4 campos/85 contenidos -- esos
        # numeros pertenecen exclusivamente a verificar_invariantes_conocidos,
        # nunca a la validacion estructural general.
        extraccion = _extraccion_minima_valida()
        candidatos = transformar_candidatos(extraccion)
        resultado = validar_staging(extraccion, candidatos)  # no debe lanzar
        self.assertTrue(resultado["ok"])


# Los tests de idempotencia (decidir_estrategia_preliminar +
# resolver_verificacion_readback) viven en test_idempotencia.py, dedicado
# al módulo idempotencia.py -- ver ese archivo.


if __name__ == "__main__":
    unittest.main()
