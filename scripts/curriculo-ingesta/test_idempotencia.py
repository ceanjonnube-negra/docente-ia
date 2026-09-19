#!/usr/bin/env python3
"""Tests deterministas de idempotencia — Currículo V1-B-3 (ajuste
semántico). No tocan Supabase: `decidir_estrategia_preliminar` y
`resolver_verificacion_readback` son funciones puras que reciben listas de
dicts ya leídas (o simuladas) — la verificación de que la lectura/escritura
real contra Supabase funciona se hizo aparte, con datos descartables ya
limpiados (ver reporte de V1-B-3B/V1-B-3).

Ejecutar: ./.venv/bin/python3 -m unittest test_idempotencia.py -v
"""

from __future__ import annotations

import unittest

from idempotencia import (
    candidatos_coinciden_exactamente,
    decidir_estrategia_preliminar,
    resolver_verificacion_readback,
)


def _candidato(clave_local, tipo="pda", parent_local="contenido:x", fingerprint="fp", estado="confirmado"):
    return {"tipo": tipo, "clave_local": clave_local, "parent_local": parent_local, "fingerprint": fingerprint, "estado_validacion": estado}


def _candidatos_ejemplo(n=3):
    return [_candidato(f"pda:x#{i}", fingerprint=f"fp{i}") for i in range(n)]


class TestDecisionPreliminar(unittest.TestCase):
    def test_sin_ingestas_previas_crea_nueva_sin_readback(self):
        decision = decidir_estrategia_preliminar([])
        self.assertEqual(decision.estrategia, "crear_nueva")
        self.assertFalse(decision.requiere_readback)

    def test_solo_fallidas_permite_reintento_limpio(self):
        decision = decidir_estrategia_preliminar([{"id": "id-1", "estado": "fallido"}])
        self.assertEqual(decision.estrategia, "crear_nueva")
        self.assertFalse(decision.requiere_readback)

    def test_una_completada_requiere_readback(self):
        decision = decidir_estrategia_preliminar([{"id": "id-1", "estado": "completado"}])
        self.assertEqual(decision.estrategia, "pendiente_verificacion_completada")
        self.assertTrue(decision.requiere_readback)
        self.assertEqual(decision.ingesta_existente_id, "id-1")

    def test_una_en_progreso_requiere_readback(self):
        decision = decidir_estrategia_preliminar([{"id": "id-1", "estado": "en_progreso"}])
        self.assertEqual(decision.estrategia, "pendiente_verificacion_en_progreso")
        self.assertTrue(decision.requiere_readback)

    # --- D. múltiples ingestas equivalentes -> abortar_conflicto, sin necesitar readback ---
    def test_d_multiples_completadas_es_conflicto_sin_readback(self):
        existentes = [{"id": "id-1", "estado": "completado"}, {"id": "id-2", "estado": "completado"}]
        decision = decidir_estrategia_preliminar(existentes)
        self.assertEqual(decision.estrategia, "abortar_conflicto")
        self.assertFalse(decision.requiere_readback)

    def test_d_una_completada_y_una_en_progreso_es_conflicto(self):
        existentes = [{"id": "id-1", "estado": "completado"}, {"id": "id-2", "estado": "en_progreso"}]
        decision = decidir_estrategia_preliminar(existentes)
        self.assertEqual(decision.estrategia, "abortar_conflicto")


class TestCandidatosCoincidenExactamente(unittest.TestCase):
    def test_coincidencia_exacta(self):
        c = _candidatos_ejemplo()
        coincide, _ = candidatos_coinciden_exactamente(c, list(c))
        self.assertTrue(coincide)

    def test_fingerprint_distinto_no_coincide(self):
        p = _candidatos_ejemplo()
        t = _candidatos_ejemplo()
        t[0]["fingerprint"] = "otro-fingerprint"
        coincide, detalle = candidatos_coinciden_exactamente(p, t)
        self.assertFalse(coincide)
        self.assertIn("fingerprint", detalle)

    def test_candidato_faltante_no_coincide(self):
        p = _candidatos_ejemplo(2)
        t = _candidatos_ejemplo(3)
        coincide, detalle = candidatos_coinciden_exactamente(p, t)
        self.assertFalse(coincide)
        self.assertIn("no están persistidos", detalle)


class TestVerificacionCompletada(unittest.TestCase):
    # --- A. completada + contenido idéntico -> reutilizar_completada / no-op ---
    def test_a_completada_identica_reutiliza(self):
        decision_preliminar = decidir_estrategia_preliminar([{"id": "id-1", "estado": "completado"}])
        persistidos = _candidatos_ejemplo()
        transformados = list(persistidos)  # idéntico
        decision = resolver_verificacion_readback(decision_preliminar, persistidos, transformados)
        self.assertEqual(decision.estrategia, "reutilizar_completada")
        self.assertEqual(decision.ingesta_existente_id, "id-1")

    # --- B. completada + fingerprint diferente -> abortar_conflicto ---
    def test_b_completada_fingerprint_diferente_aborta(self):
        decision_preliminar = decidir_estrategia_preliminar([{"id": "id-1", "estado": "completado"}])
        persistidos = _candidatos_ejemplo()
        transformados = _candidatos_ejemplo()
        transformados[1]["fingerprint"] = "fingerprint-cambiado"
        decision = resolver_verificacion_readback(decision_preliminar, persistidos, transformados)
        self.assertEqual(decision.estrategia, "abortar_conflicto")

    # --- C. completada + candidato faltante -> abortar_conflicto ---
    def test_c_completada_candidato_faltante_aborta(self):
        decision_preliminar = decidir_estrategia_preliminar([{"id": "id-1", "estado": "completado"}])
        persistidos = _candidatos_ejemplo(2)  # menos de lo esperado
        transformados = _candidatos_ejemplo(3)
        decision = resolver_verificacion_readback(decision_preliminar, persistidos, transformados)
        self.assertEqual(decision.estrategia, "abortar_conflicto")

    def test_completada_nunca_se_acepta_solo_por_identidad(self):
        # Verificación explícita del requisito central: aunque la
        # identidad (fuente_hash+perfil+version_pipeline+scope_hash) ya
        # haya calificado como "pendiente_verificacion_completada", una
        # sola diferencia de contenido debe bloquear reutilizar_completada.
        decision_preliminar = decidir_estrategia_preliminar([{"id": "id-1", "estado": "completado"}])
        persistidos = _candidatos_ejemplo()
        transformados = _candidatos_ejemplo()
        transformados[0]["estado_validacion"] = "dudoso"  # una sola diferencia
        decision = resolver_verificacion_readback(decision_preliminar, persistidos, transformados)
        self.assertNotEqual(decision.estrategia, "reutilizar_completada")
        self.assertEqual(decision.estrategia, "abortar_conflicto")


class TestVerificacionEnProgreso(unittest.TestCase):
    # --- E. en_progreso completa e idéntica -> recuperación segura ---
    def test_e_en_progreso_completa_identica_se_recupera(self):
        decision_preliminar = decidir_estrategia_preliminar([{"id": "id-1", "estado": "en_progreso"}])
        persistidos = _candidatos_ejemplo()
        transformados = list(persistidos)
        decision = resolver_verificacion_readback(decision_preliminar, persistidos, transformados)
        self.assertEqual(decision.estrategia, "recuperar_en_progreso")
        self.assertEqual(decision.ingesta_existente_id, "id-1")

    # --- F. en_progreso parcial -> abortar ---
    def test_f_en_progreso_parcial_aborta(self):
        decision_preliminar = decidir_estrategia_preliminar([{"id": "id-1", "estado": "en_progreso"}])
        persistidos = _candidatos_ejemplo(1)  # solo se alcanzó a insertar 1 de 3
        transformados = _candidatos_ejemplo(3)
        decision = resolver_verificacion_readback(decision_preliminar, persistidos, transformados)
        self.assertEqual(decision.estrategia, "abortar_conflicto")

    def test_en_progreso_nunca_se_marca_completada_automaticamente_sin_verificar(self):
        # decidir_estrategia_preliminar por sí sola NUNCA decide
        # recuperar_en_progreso -- siempre exige el paso de verificación
        # (requiere_readback=True), nunca "porque existe, ya está bien".
        decision_preliminar = decidir_estrategia_preliminar([{"id": "id-1", "estado": "en_progreso"}])
        self.assertNotEqual(decision_preliminar.estrategia, "recuperar_en_progreso")
        self.assertTrue(decision_preliminar.requiere_readback)


class TestResolverSinReadbackPrevioLanza(unittest.TestCase):
    def test_no_se_puede_resolver_sin_fase_preliminar_que_lo_requiera(self):
        decision_preliminar = decidir_estrategia_preliminar([])  # crear_nueva, no requiere readback
        with self.assertRaises(ValueError):
            resolver_verificacion_readback(decision_preliminar, [], [])


if __name__ == "__main__":
    unittest.main()
