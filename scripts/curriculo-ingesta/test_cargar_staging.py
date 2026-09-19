#!/usr/bin/env python3
"""Tests deterministas de la generación de SQL de carga — Currículo
V1-B-3B. Prueban exclusivamente la construcción de texto SQL (dollar-
quoting seguro, forma de las sentencias) — NUNCA tocan Supabase. La
verificación de que el SQL generado realmente funciona contra PostgreSQL
real (atomicidad, mecánica de las CTEs) se hizo aparte, contra la base de
datos real, con datos descartables ya limpiados — ver el reporte de
V1-B-3B para esa evidencia.

Ejecutar: ./.venv/bin/python3 -m unittest test_cargar_staging.py -v
"""

from __future__ import annotations

import json
import unittest

from cargar_staging import (
    FUENTE_URL_FASE4_CONOCIDA,
    TIPOS_CANDIDATO_COLUMNAS,
    _dq,
    construir_sql_carga_atomica,
    construir_sql_marcar_completado,
    construir_sql_readback,
    construir_sql_readback_identidad,
    construir_sql_verificacion_identidad,
)
from transformador import calcular_scope_hash, construir_scope_canonico


def _identidad_ejemplo() -> dict:
    return {
        "fuente_hash": "hash123",
        "fuente_url": None,
        "perfil_extractor": "perfil_x",
        "version_pipeline": "extractor:0.1.0+transformador:0.1.0",
        "scope_solicitado": {"nivel_educativo": "primaria", "fase_clave": "fase_4", "grados": ["3", "4"], "campos": ["lenguajes"]},
        "scope_hash": "scopehash123",
        "metadata": {"organismo": "SEP"},
    }


class TestDollarQuoting(unittest.TestCase):
    def test_texto_normal(self):
        self.assertEqual(_dq("hola", "t"), "$t$hola$t$")

    def test_texto_con_comillas_simples_y_dobles_no_rompe(self):
        texto = "búsqueda 'con apóstrofe' y \"comillas dobles\""
        resultado = _dq(texto, "t")
        self.assertTrue(resultado.startswith("$t$"))
        self.assertTrue(resultado.endswith("$t$"))
        self.assertIn(texto, resultado)

    def test_colision_de_marcador_lanza_assertion(self):
        with self.assertRaises(AssertionError):
            _dq("texto que contiene $t$ literalmente", "t")


class TestSqlVerificacionIdentidad(unittest.TestCase):
    def test_incluye_los_4_componentes_de_identidad(self):
        sql = construir_sql_verificacion_identidad(_identidad_ejemplo())
        self.assertIn("hash123", sql)
        self.assertIn("perfil_x", sql)
        self.assertIn("extractor:0.1.0+transformador:0.1.0", sql)
        self.assertIn("scopehash123", sql)
        self.assertIn("from public.ingesta_curricular", sql)
        self.assertNotIn("delete", sql.lower())
        self.assertNotIn("insert", sql.lower())
        self.assertNotIn("update", sql.lower())


class TestSqlCargaAtomica(unittest.TestCase):
    def _candidatos_ejemplo(self):
        return [
            {"tipo": "campo", "clave_local": "campo:lenguajes", "parent_local": None,
             "payload": {"clave": "lenguajes", "nombre": "Lenguajes"}, "fingerprint": "fp1",
             "evidencia": {}, "estado_validacion": "confirmado", "origen": "regla"},
            {"tipo": "contenido", "clave_local": "contenido:lenguajes#0", "parent_local": "campo:lenguajes",
             "payload": {"clave_oficial": None, "titulo": "Título con apóstrofe's y salto\nde línea"},
             "fingerprint": "fp2", "evidencia": {"texto_original": "raw"}, "estado_validacion": "confirmado", "origen": "regla"},
        ]

    def test_statement_primario_es_select_no_update(self):
        # Ver docstring del módulo: un UPDATE como statement primario de
        # un WITH cuyas CTE ya modifican la misma tabla NO aplicó su SET
        # en la verificación real contra Supabase -- por eso el
        # statement primario aquí debe ser siempre un SELECT puro.
        sql = construir_sql_carga_atomica(_identidad_ejemplo(), self._candidatos_ejemplo())
        # El bloque de CTEs cierra con ")" en su propia línea,
        # inmediatamente seguido del statement primario -- debe ser
        # "select", nunca "update" (ver docstring del módulo: un UPDATE
        # aquí no aplicó su SET al probarse contra Supabase real).
        self.assertIn("\n)\nselect\n", sql.lower())
        self.assertNotIn("\nupdate ", sql.lower())

    def test_texto_con_apostrofes_y_saltos_de_linea_no_rompe_sql(self):
        candidatos = self._candidatos_ejemplo()
        sql = construir_sql_carga_atomica(_identidad_ejemplo(), candidatos)
        # El JSON embebido debe seguir siendo válido tal cual quedó
        # serializado (round-trip), incluso con apóstrofes/saltos de línea.
        candidatos_json = json.dumps(candidatos, ensure_ascii=False)
        self.assertIn(candidatos_json, sql)
        # y ese fragmento embebido debe seguir siendo JSON válido
        inicio = sql.index(candidatos_json)
        self.assertEqual(json.loads(sql[inicio: inicio + len(candidatos_json)]), candidatos)

    def test_usa_jsonb_to_recordset_con_las_columnas_esperadas(self):
        sql = construir_sql_carga_atomica(_identidad_ejemplo(), self._candidatos_ejemplo())
        self.assertIn("jsonb_to_recordset", sql)
        self.assertIn(TIPOS_CANDIDATO_COLUMNAS, sql)

    def test_fuente_url_null_cuando_no_se_conoce(self):
        sql = construir_sql_carga_atomica(_identidad_ejemplo(), self._candidatos_ejemplo())
        self.assertIn("null,\n", sql)


class TestSqlMarcarCompletado(unittest.TestCase):
    def test_condicionado_a_conteo_exacto_de_candidatos(self):
        sql = construir_sql_marcar_completado("abc-123", 1063)
        self.assertIn("= 1063", sql)
        self.assertIn("estado = 'en_progreso'", sql)
        self.assertIn("set estado = 'completado'", sql)

    def test_no_es_incondicional(self):
        # nunca debe marcar completado sin la condición de conteo
        sql = construir_sql_marcar_completado("abc-123", 5)
        self.assertIn("and (select count(*)", sql)


class TestSqlReadback(unittest.TestCase):
    def test_readback_candidatos_selecciona_columnas_minimas_requeridas(self):
        sql = construir_sql_readback("abc-123")
        for columna in ("tipo", "clave_local", "parent_local", "fingerprint", "estado_validacion"):
            self.assertIn(columna, sql)
        self.assertNotIn("payload", sql)  # no hace falta releer el contenido completo para comparar

    def test_readback_identidad_selecciona_los_4_componentes(self):
        sql = construir_sql_readback_identidad("abc-123")
        for columna in ("fuente_hash", "perfil_extractor", "version_pipeline", "scope_hash"):
            self.assertIn(columna, sql)


class TestFuenteUrlNoAfectaIdentidad(unittest.TestCase):
    """G. fuente_url no modifica identidad ni scope_hash."""

    def _extraccion_minima(self):
        return {
            "scope": {"nivel_educativo": "primaria", "fase_clave": "fase_4", "grados": ["3", "4"], "campos": ["lenguajes"]},
        }

    def test_scope_hash_identico_con_o_sin_fuente_url(self):
        # construir_scope_canonico/calcular_scope_hash (transformador.py)
        # ni siquiera reciben fuente_url como argumento -- la única forma
        # de demostrar que "no participa" es confirmar que el hash es
        # función exclusiva del scope, sin importar qué fuente_url se le
        # asigne por separado al dict de identidad completo.
        extraccion = self._extraccion_minima()
        scope = construir_scope_canonico(extraccion)
        hash_a = calcular_scope_hash(scope)
        hash_b = calcular_scope_hash(scope)  # mismo scope, calculado de nuevo
        self.assertEqual(hash_a, hash_b)
        self.assertNotIn("fuente_url", scope)
        self.assertNotIn("url", str(scope).lower())

    def test_identidad_con_fuente_url_null_vs_conocida_mismo_scope_hash(self):
        identidad_sin_url = {"scope_solicitado": construir_scope_canonico(self._extraccion_minima()), "fuente_url": None}
        identidad_con_url = {**identidad_sin_url, "fuente_url": FUENTE_URL_FASE4_CONOCIDA}
        hash_sin = calcular_scope_hash(identidad_sin_url["scope_solicitado"])
        hash_con = calcular_scope_hash(identidad_con_url["scope_solicitado"])
        self.assertEqual(hash_sin, hash_con)
        self.assertNotEqual(identidad_sin_url["fuente_url"], identidad_con_url["fuente_url"])

    def test_sql_carga_atomica_incluye_fuente_url_solo_como_columna_no_en_scope_hash(self):
        identidad = {
            "fuente_hash": "h", "fuente_url": FUENTE_URL_FASE4_CONOCIDA,
            "perfil_extractor": "p", "version_pipeline": "v",
            "scope_solicitado": {"nivel_educativo": "primaria", "fase_clave": "fase_4", "grados": ["3"], "campos": ["x"]},
            "scope_hash": "scopehash-no-depende-de-url",
            "metadata": {},
        }
        sql = construir_sql_carga_atomica(identidad, [])
        self.assertIn(FUENTE_URL_FASE4_CONOCIDA, sql)
        self.assertIn("scopehash-no-depende-de-url", sql)
        # la URL aparece en la columna fuente_url, nunca dentro del valor
        # de scope_hash embebido.
        idx_scope_hash = sql.index("scopehash-no-depende-de-url")
        contexto = sql[max(0, idx_scope_hash - 40): idx_scope_hash]
        self.assertNotIn(FUENTE_URL_FASE4_CONOCIDA, contexto)


if __name__ == "__main__":
    unittest.main()
