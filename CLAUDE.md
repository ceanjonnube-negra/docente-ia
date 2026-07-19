@AGENTS.md
# DOCENTE IA — REGLAS MAESTRAS DEL PROYECTO

## Objetivo
Construir una aplicación móvil y web para docentes de educación básica en México que concentre, organice y aproveche toda la información del grupo para ahorrar tiempo, evitar capturas repetidas y facilitar el seguimiento grupal e individual.

## Principios obligatorios

1. La aplicación debe ser móvil primero.
2. Toda función debe ser clara, rápida y fácil de usar.
3. El docente debe registrar cada dato una sola vez.
4. La información registrada debe reutilizarse automáticamente en historial, estadísticas, reportes, fichas descriptivas, documentos e inteligencia artificial.
5. No duplicar funciones, pantallas, tablas ni información.
6. No crear apartados separados cuando una función pueda integrarse de forma más clara dentro de otro módulo.
7. La sección Lista es el centro del seguimiento grupal e individual.
8. La IA debe usar datos reales de la aplicación y no inventar información.
9. Las funciones frecuentes deben resolverse con el menor número posible de pasos.
10. No modificar módulos que no formen parte de la tarea actual.
11. Conservar el estilo visual existente salvo que la instrucción solicite cambiarlo.
12. Toda información importante debe guardarse de forma permanente y seguir disponible al recargar la aplicación.
13. Mostrar errores claros al usuario; no dejar fallas únicamente en consola.
14. Reutilizar las tablas y estructuras existentes antes de crear otras nuevas.
15. No realizar cambios opcionales ni agregar funciones no solicitadas.

## Método de trabajo

- Trabajar un módulo a la vez.
- Trabajar una tarea pequeña a la vez.
- Antes de modificar, revisar lo que ya existe.
- No reabrir decisiones funcionales que ya están definidas.
- Implementar directamente en los archivos del proyecto.
- Al terminar cada tarea, informar:
  1. qué se modificó;
  2. qué archivo se tocó;
  3. cómo se prueba;
  4. qué quedó pendiente.
- Detenerse después de cada tarea y esperar la siguiente instrucción.

## Prioridad actual

### Sprint 1 — Módulo Lista

No trabajar en Planeación, Documentos, Chat IA ni otros módulos hasta terminar Lista.

Lista debe permitir:

- ver todos los alumnos del grupo;
- registrar y consultar asistencia;
- abrir la ficha individual;
- consultar seguimiento grupal;
- registrar incidencias, evidencias, evaluaciones y participaciones;
- ver historial individual;
- generar información reutilizable para reportes y fichas;
- detectar alumnos que requieren atención.

## Regla central del módulo Lista

Un registro realizado una sola vez debe actualizar automáticamente el expediente individual, el seguimiento grupal, el historial, las estadísticas y los futuros análisis de IA.

## Decisión funcional vigente

La sección independiente llamada Seguimiento no se utilizará como módulo separado. El seguimiento grupal e individual se concentrará dentro de Lista.

## Forma de trabajo con el agente

Antes de modificar cualquier archivo, el agente debe:

1. Analizar el módulo completo antes de proponer cambios.
2. Explicar qué archivos modificará y por qué.
3. No modificar código que no pertenezca a la tarea actual.
4. Implementar los cambios por etapas pequeñas y verificables.
5. Esperar confirmación antes de continuar con la siguiente etapa.
6. Mantener siempre la compatibilidad con las funciones existentes.
7. Reutilizar tablas, componentes y lógica antes de crear elementos nuevos.
8. Priorizar rendimiento, claridad y simplicidad del código.
9. Si existe más de una solución, proponer la más simple y mantenible.
10. Nunca duplicar funcionalidades que ya existan en el proyecto.