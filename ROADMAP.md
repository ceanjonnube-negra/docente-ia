# Roadmap — Docente IA

> Basado en el análisis completo del repositorio realizado en esta sesión (ver `PROJECT_MAP.md` para el detalle técnico). Refleja el estado al 2026-07-14, commit `74e0ea1`.

Prioridad vigente del proyecto (regla del proyecto): **Sprint 1 = módulo Lista**. No se trabaja Planeación, Documentos ni Chat IA como módulos nuevos hasta terminar Lista.

## Resumen por módulo

| Módulo | Estado | Prioridad |
|---|---|---|
| **CORE — Alumno permanente / Inscripción** | Diseñado (decisión documentada en `DECISIONS.md`, Decisiones 10-11), pendiente de implementar | 🔴 Alta — bloqueante antes de seguir ampliando Lista con nuevas capturas |
| Lista (asistencia, ficha individual, seguimiento) | En desarrollo avanzado | 🔴 Alta — Sprint 1 activo |
| Autenticación / Onboarding | Terminado | — (base, no tocar sin necesidad) |
| Grupos (alta de grupo, importación de lista oficial) | En desarrollo | 🔴 Alta — soporta a Lista |
| Periodos de evaluación | En desarrollo (base funcional) | 🟠 Media |
| Chat IA / Motor de Contexto | En desarrollo, en pausa por prioridad de Sprint 1 | 🟡 En espera |
| Documentos institucionales (RAG) | Terminado (funcional) | 🟡 En espera |
| Calendario | Terminado (funcional) | 🟡 En espera |
| Historial de documentos generados | Terminado (funcional) | 🟡 En espera |
| Planeación | No iniciado (stub) | ⚪ Bloqueado hasta cerrar Sprint 1 |
| Seguimiento (pantalla separada) | No iniciado (stub) — **decisión vigente: no se construye como módulo aparte** | ⚪ No aplica (ver DECISIONS.md) |

---

## 0. CORE — Alumno permanente / Inscripción — 🔴 Diseñado, pendiente de implementar

**Decisión documentada** (`DECISIONS.md`, Decisiones 10 y 11): el alumno es una entidad permanente; su relación con un grupo se representa mediante una inscripción (alumno + grupo + ciclo escolar + número de lista + fecha de alta + estado activo/inactivo), reemplazando la FK directa `alumnos.grupo_id`. Resuelve la duplicidad de fuentes de verdad entre `alumnos.grupo_id` (usada por Lista/Ficha/importaciones) e `inscripciones` (usada solo por el Chat IA).

**Pendiente de implementar (requiere autorización explícita, incluye cambios de esquema en Supabase):**
- Completar el esquema de `inscripciones` (`ciclo_escolar_id`, `numero_lista`, `fecha_alta`, `estado`).
- Agregar `inscripcion_id` a `incidencias`, `evaluaciones`, `evidencias`, `necesidades_apoyo`, `fichas_descriptivas` (y ya `asistencias` tiene `grupo_id`).
- Migrar los datos existentes de `alumnos.grupo_id`/`numero_lista` hacia inscripciones reales.
- Ajustar `lib/sesionContexto.ts` y las pantallas que hoy leen `alumnos.grupo_id` para usar la inscripción activa.

Este trabajo se considera **bloqueante** antes de construir alta de incidencias/evaluaciones/evidencias/necesidades de apoyo desde la Ficha (para no capturar esos datos sin `inscripcion_id` y tener que migrarlos después).

---

## 1. Módulo Lista — 🔴 Sprint 1 activo

**Terminado:**
- Pantalla `/dashboard/lista`: listado de alumnos con filtros (todos/niñas/niños/presentes/ausentes), búsqueda, conteos por sexo, indicador de presente/ausente del día.
- Ficha Inteligente del Alumno `/dashboard/lista/[alumnoId]`: 9 pestañas (Resumen, Datos, Asistencia, Incidencias, Evaluaciones, Evidencias, Necesidades de apoyo, Fichas descriptivas, Historial); datos personales editables (número de lista, CURP, sexo, fecha de nacimiento); dos pasadas de rediseño visual premium ya aplicadas. Todo sin commit todavía en el working tree.
- Registro de asistencia diaria (`/dashboard/asistencia`) con guardado vía `/api/asistencia-guardar`.
- Importación de lista oficial por foto/Excel/PDF/Word (`/dashboard/grupos/[id]/importar` + `/api/importar-alumnos`).
- Enriquecimiento de datos de alumnos existentes (CURP/sexo/fecha de nacimiento/número de lista) desde foto (`/api/importar-datos-alumnos`).
- Periodos de evaluación: pantalla y API básicas (`/dashboard/periodos-evaluacion`, `/api/periodos-evaluacion`).

**En desarrollo / con huecos conocidos:**
- Registro (alta) de incidencias, evidencias, evaluaciones, necesidades de apoyo y fichas descriptivas: **ya existe lectura de las cinco** en la Ficha, pero **no hay pantalla ni API para crear** ninguna todavía (tampoco "participaciones", que no existe como tabla ni concepto en el código).
- Seguimiento grupal (vista agregada del grupo más allá del listado con conteos) no está construido como tal.
- Detección automática de alumnos que requieren atención: no implementada.
- El módulo **no tiene entrada de navegación** desde la rueda de `/dashboard` ni desde el drawer de `/dashboard/chat` (solo alcanzable por URL directa) — bloqueante de usabilidad, ver `PROJECT_MAP.md` sección 10.

**Falta por construir (dentro del alcance de Sprint 1, según reglas del proyecto):**
- Alta de incidencias, evidencias, evaluaciones, necesidades de apoyo desde la ficha individual o desde Lista — **una vez implementado el CORE (sección 0)**, para capturarlas ya con `inscripcion_id`.
- Vista de seguimiento grupal integrada dentro de Lista (no como pantalla separada).
- Reglas de detección de alumnos que requieren atención.
- Enlace de navegación a Lista y a Periodos de evaluación.

---

## 2. Autenticación / Onboarding — Terminado

`/login`, `/registro`, `/onboarding` funcionan de extremo a extremo contra Supabase Auth y `perfiles_docentes`. No se ha detectado trabajo pendiente aquí; forma parte del modelo "legado" de perfil plano (ver DECISIONS.md).

## 3. Grupos — En desarrollo, soporta a Lista

**Terminado:** alta de grupo (`/dashboard/grupos/nuevo`) con institución/ciclo escolar/nivel/grado/grupo; importación de lista oficial.

**Falta:** la pantalla `configuracion-inicial` enlaza a `/dashboard/grupos/[id]/alumnos/nuevo` (captura manual de alumnos), **ruta que no existe todavía**.

## 4. Periodos de evaluación — En desarrollo

Pantalla y API para editar fechas de inicio/fin por periodo ya funcionan. Falta integrarlo visualmente con Lista/Calendario y definir su uso dentro del flujo de evaluación.

## 5. Chat IA / Motor de Contexto — En espera (no tocar hasta cerrar Sprint 1)

Funcional: streaming con Claude, generación de planeaciones/rúbricas/exámenes/citatorios, exportación a Word, RAG contra documentos institucionales, Clasificador de Nivel 0 con enrutamiento a `consultar_asistencia`, `ficha_descriptiva`, `planeacion_nueva`.

Pendiente (fuera de alcance de Sprint 1, documentado para más adelante): alinear el modelo de asistencia que asume el Motor de Contexto (`falta/retardo/justificada`) con el modelo real de la UI de Asistencia (`presente: boolean`).

## 6. Documentos institucionales (RAG) — Terminado (funcional), en espera

Subida, extracción de texto, chunking y embeddings funcionan end-to-end.

## 7. Calendario — Terminado (funcional), en espera

Calendario mensual con eventos SEP precargados y eventos propios del docente.

## 8. Historial — Terminado (funcional), en espera

Lista de documentos generados, filtro por tipo, descarga a Word, eliminación.

## 9. Planeación — No iniciado

Solo existe el stub visual "Próximamente". Bloqueado explícitamente hasta cerrar Sprint 1 (Lista).

## 10. Seguimiento (pantalla independiente) — No aplica

Existe un stub visual "Próximamente" en `/dashboard/seguimiento`, pero la **decisión funcional vigente es que este módulo no se construirá como pantalla separada**: el seguimiento grupal e individual se concentra dentro de Lista. El stub y sus enlaces (rueda de `/dashboard`, drawer de chat) deberían retirarse o redirigirse a Lista cuando se retome ese trabajo, para no dejar una ruta "fantasma" que contradiga la decisión.

---

## Prioridad consolidada

1. 🔴 **Implementar el CORE** (sección 0): esquema completo de `inscripciones`, `inscripcion_id` en las tablas de evento, migración de `alumnos.grupo_id` — previo autorización explícita de cambios en Supabase.
2. 🔴 **Terminar Lista**: alta de incidencias/evidencias/evaluaciones/necesidades de apoyo (ya con `inscripcion_id`), seguimiento grupal integrado, detección de alumnos que requieren atención, y resolver la falta de navegación hacia Lista.
3. 🔴 Cerrar huecos de Grupos (ruta rota de alta manual de alumnos).
4. 🟠 Consolidar Periodos de evaluación con el resto de Lista.
5. 🟡 Retomar Chat IA/Motor de Contexto solo después de cerrar Sprint 1, empezando por alinear el modelo de asistencia y por leer `inscripciones` con el esquema completo del CORE.
6. ⚪ Planeación y Seguimiento (como módulo) quedan bloqueados hasta entonces.
