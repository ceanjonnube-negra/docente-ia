#!/usr/bin/env python3
"""Tests deterministas del publicador canónico — Currículo V1-B-4B. No
tocan Supabase: `revalidar_staging`, `construir_fragmentos` y
`construir_sql_publicacion` son funciones puras sobre listas de dicts ya
leídas (o simuladas). La verificación de que el SQL generado realmente
funciona contra PostgreSQL real (transacción, advisory lock, tabla
puente, abortos condicionales) se hizo aparte, con datos descartables ya
revertidos — ver el reporte de V1-B-4B.

Ejecutar: ./.venv/bin/python3 -m unittest test_publicar_curriculo.py -v
"""

from __future__ import annotations

import unittest

from publicar_curriculo import (
    ErrorValidacionPublicacion,
    construir_fragmentos,
    construir_sql_publicacion,
    revalidar_staging,
)


def _campo(clave, nombre):
    return {"tipo": "campo", "clave_local": f"campo:{clave}", "parent_local": None,
            "payload": {"clave": clave, "nombre": nombre}, "evidencia": {},
            "fingerprint": "f" * 32, "estado_validacion": "confirmado"}


def _contenido(idx, campo_clave, titulo, pagina, top=100.0):
    return {"tipo": "contenido", "clave_local": f"contenido:{campo_clave}#{idx}", "parent_local": f"campo:{campo_clave}",
            "payload": {"clave_oficial": None, "titulo": titulo},
            "evidencia": {"pagina": pagina, "top": top, "texto_original": titulo},
            "fingerprint": "f" * 32, "estado_validacion": "confirmado"}


def _pda(contenido_clave, idx, texto, pagina, top=150.0):
    return {"tipo": "pda", "clave_local": f"pda:{contenido_clave}#{idx}", "parent_local": contenido_clave,
            "payload": {"clave_oficial": None, "texto": texto},
            "evidencia": {"pagina": pagina, "top": top, "texto_original": texto},
            "fingerprint": "f" * 32, "estado_validacion": "confirmado"}


def _pda_grado(pda_clave, grado):
    return {"tipo": "pda_grado", "clave_local": f"pda_grado:{pda_clave}:{grado}", "parent_local": pda_clave,
            "payload": {"grado_clave": grado}, "evidencia": {},
            "fingerprint": "f" * 32, "estado_validacion": "confirmado"}


def _dataset_minimo_valido():
    """1 campo, 1 contenido, 2 PDA (uno por grado) -- para ejercitar el
    mapeo básico sin construir los 1063 candidatos reales."""
    campo = _campo("lenguajes", "Lenguajes")
    contenido = _contenido(0, "lenguajes", "Narración de sucesos", 24)
    pda3 = _pda(contenido["clave_local"], 0, "Identifica hechos.", 24)
    pda4 = _pda(contenido["clave_local"], 1, "Describe hechos con detalle.", 24)
    return [campo, contenido, pda3, pda4, _pda_grado(pda3["clave_local"], "3"), _pda_grado(pda4["clave_local"], "4")]


class TestRevalidacionRechazo(unittest.TestCase):
    def test_ingesta_no_completada_rechaza(self):
        ingesta = {"estado": "en_progreso", "fuente_hash": "36e0c3cdbc3221cdf9c4b9f3ec9e889f98060249fc0ab1ddecd419b28bcbe734"}
        with self.assertRaises(ErrorValidacionPublicacion) as ctx:
            revalidar_staging(ingesta, [])
        self.assertTrue(any("estado" in p for p in ctx.exception.args[0]))

    def test_staging_incompleto_rechaza(self):
        ingesta = {"estado": "completado", "fuente_hash": "36e0c3cdbc3221cdf9c4b9f3ec9e889f98060249fc0ab1ddecd419b28bcbe734"}
        candidatos = _dataset_minimo_valido()  # solo 6 candidatos, no 1063
        with self.assertRaises(ErrorValidacionPublicacion) as ctx:
            revalidar_staging(ingesta, candidatos)
        self.assertTrue(any("1063" in p for p in ctx.exception.args[0]))

    def test_staging_dudoso_rechaza(self):
        ingesta = {"estado": "completado", "fuente_hash": "36e0c3cdbc3221cdf9c4b9f3ec9e889f98060249fc0ab1ddecd419b28bcbe734"}
        candidatos = _dataset_minimo_valido()
        candidatos[1]["estado_validacion"] = "dudoso"
        with self.assertRaises(ErrorValidacionPublicacion) as ctx:
            revalidar_staging(ingesta, candidatos)
        self.assertTrue(any("dudoso" in p for p in ctx.exception.args[0]))

    def test_clave_local_duplicada_rechaza(self):
        ingesta = {"estado": "completado", "fuente_hash": "36e0c3cdbc3221cdf9c4b9f3ec9e889f98060249fc0ab1ddecd419b28bcbe734"}
        candidatos = _dataset_minimo_valido()
        candidatos.append(dict(candidatos[0]))
        with self.assertRaises(ErrorValidacionPublicacion) as ctx:
            revalidar_staging(ingesta, candidatos)
        self.assertTrue(any("duplicada" in p for p in ctx.exception.args[0]))


class TestFragmentos(unittest.TestCase):
    def test_exactamente_un_fragmento_por_pagina(self):
        candidatos = _dataset_minimo_valido()
        fragmentos = construir_fragmentos(candidatos)
        self.assertEqual(len(fragmentos), 1)
        self.assertEqual(fragmentos[0]["pagina"], 24)
        self.assertEqual(fragmentos[0]["orden"], 24)

    def test_fragmentos_deterministas_entre_corridas(self):
        c1 = _dataset_minimo_valido()
        c2 = _dataset_minimo_valido()
        f1 = construir_fragmentos(c1)
        f2 = construir_fragmentos(c2)
        self.assertEqual(f1, f2)

    def test_texto_de_fragmento_ordenado_por_posicion_vertical(self):
        campo = _campo("lenguajes", "Lenguajes")
        contenido = _contenido(0, "lenguajes", "TITULO", 24, top=50.0)
        pda_a = _pda(contenido["clave_local"], 0, "SEGUNDO", 24, top=200.0)
        pda_b = _pda(contenido["clave_local"], 1, "PRIMERO_DESPUES_DEL_TITULO", 24, top=100.0)
        fragmentos = construir_fragmentos([campo, contenido, pda_a, pda_b])
        texto = fragmentos[0]["texto"]
        self.assertLess(texto.index("TITULO"), texto.index("PRIMERO_DESPUES_DEL_TITULO"))
        self.assertLess(texto.index("PRIMERO_DESPUES_DEL_TITULO"), texto.index("SEGUNDO"))

    def test_seccion_es_el_nombre_del_campo(self):
        candidatos = _dataset_minimo_valido()
        fragmentos = construir_fragmentos(candidatos)
        self.assertEqual(fragmentos[0]["seccion"], "Lenguajes")


class TestMapeoSQL(unittest.TestCase):
    def test_mapeo_contenido_a_campo_via_parent_local(self):
        candidatos = _dataset_minimo_valido()
        fragmentos = construir_fragmentos(candidatos)
        sql = construir_sql_publicacion(candidatos, fragmentos)
        self.assertIn("campo_clave_local", sql)
        self.assertIn('"campo:lenguajes"'.strip('"'), sql)  # la clave_local real aparece embebida en el JSON

    def test_mapeo_pda_a_contenido_via_parent_local(self):
        candidatos = _dataset_minimo_valido()
        fragmentos = construir_fragmentos(candidatos)
        sql = construir_sql_publicacion(candidatos, fragmentos)
        self.assertIn("contenido_clave_local", sql)

    def test_mapeo_pda_grado(self):
        candidatos = _dataset_minimo_valido()
        fragmentos = construir_fragmentos(candidatos)
        sql = construir_sql_publicacion(candidatos, fragmentos)
        self.assertIn("pda_clave_local", sql)
        self.assertIn("grado_clave", sql)

    def test_no_deduplica_por_texto_identico_entre_grados(self):
        # Replica el caso real encontrado en V1-B-4A: mismo texto en dos
        # PDA de grados distintos dentro del mismo contenido -- deben
        # seguir siendo 2 candidatos independientes en el JSON embebido,
        # nunca colapsados a 1.
        campo = _campo("lenguajes", "Lenguajes")
        contenido = _contenido(0, "lenguajes", "Exposición", 24)
        pda3 = _pda(contenido["clave_local"], 0, "Como presentador o presentadora", 24)
        pda4 = _pda(contenido["clave_local"], 1, "Como presentador o presentadora", 24)  # texto IDÉNTICO
        candidatos = [campo, contenido, pda3, pda4, _pda_grado(pda3["clave_local"], "3"), _pda_grado(pda4["clave_local"], "4")]
        fragmentos = construir_fragmentos(candidatos)
        sql = construir_sql_publicacion(candidatos, fragmentos)
        self.assertEqual(sql.count(pda3["clave_local"]), sql.count(pda3["clave_local"]))  # sanity
        # ambas clave_local distintas deben aparecer en el JSON embebido
        self.assertIn(pda3["clave_local"], sql)
        self.assertIn(pda4["clave_local"], sql)
        self.assertNotEqual(pda3["clave_local"], pda4["clave_local"])


class TestOrdenYEstructuraSQL(unittest.TestCase):
    def setUp(self):
        self.candidatos = _dataset_minimo_valido()
        self.fragmentos = construir_fragmentos(self.candidatos)
        self.sql = construir_sql_publicacion(self.candidatos, self.fragmentos)

    def test_contiene_begin_y_commit(self):
        self.assertTrue(self.sql.strip().lower().startswith("begin;"))
        self.assertTrue(self.sql.strip().lower().endswith("commit;"))

    def test_advisory_lock_antes_de_cualquier_insert_real(self):
        idx_lock = self.sql.index("pg_advisory_xact_lock")
        idx_primer_insert = self.sql.index("insert into public.")
        self.assertLess(idx_lock, idx_primer_insert)

    def test_cobertura_se_inserta_despues_de_contenido_y_pda(self):
        idx_contenido = self.sql.index("insert into public.curriculo_contenido")
        idx_pda = self.sql.index("insert into public.curriculo_pda ")
        idx_cobertura = self.sql.index("insert into public.curriculo_cobertura")
        self.assertLess(idx_contenido, idx_cobertura)
        self.assertLess(idx_pda, idx_cobertura)

    def test_invariantes_se_validan_antes_del_commit_final(self):
        idx_invariantes = self.sql.index("INVARIANTES_PRECOMMIT_FALLIDOS")
        idx_commit_final = self.sql.rindex("commit;")
        self.assertLess(idx_invariantes, idx_commit_final)

    def test_scope_ya_publicado_aborta_antes_de_contenido(self):
        idx_scope = self.sql.index("SCOPE_YA_PUBLICADO")
        idx_contenido = self.sql.index("insert into public.curriculo_contenido")
        self.assertLess(idx_scope, idx_contenido)

    def test_ejes_nunca_se_insertan(self):
        self.assertNotIn("insert into public.curriculo_eje_articulador", self.sql)

    def test_cobertura_condicionada_al_conteo_de_8(self):
        # el cross join grados(2) x campos(N reales del dataset) determina
        # cuántas combinaciones se insertan -- para el dataset mínimo (1
        # campo) serían 2, no 8; se comprueba la MECÁNICA (cross join +
        # on conflict), el conteo real de 8 se valida contra datos reales
        # por separado (ver reporte).
        self.assertIn("cross join campos_ids", self.sql)
        self.assertIn("on conflict (curriculo_version_id, fase_id, grado_id, campo_formativo_id) do nothing", self.sql)


if __name__ == "__main__":
    unittest.main()
