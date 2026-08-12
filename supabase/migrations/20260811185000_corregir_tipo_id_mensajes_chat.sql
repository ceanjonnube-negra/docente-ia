-- Corrección aislada sobre 20260811184000_crear_conversaciones_chat.sql
-- (PASO 2 del plan de historial persistente — descubierto probando
-- persistencia.ts contra datos reales): mensajes_chat.id se creó como
-- uuid, pero el id real que genera la app para cada mensaje
-- (AsistenteService.ts: `msg-${Date.now()}-${contadorId++}`) NUNCA es
-- un UUID — es un string simple. El primer insert real con ese id
-- falló con "invalid input syntax for type uuid".
--
-- Segura: la tabla sigue con 0 filas reales (creada hace minutos, sin
-- uso todavía fuera de pruebas temporales ya limpiadas) — no hay dato
-- que convertir ni perder. No toca conversaciones_chat, RLS, índices
-- ni ninguna otra tabla.

alter table public.mensajes_chat
  alter column id type text;

-- Rollback documentado (nunca ejecutado automáticamente):
-- alter table public.mensajes_chat alter column id type uuid using id::uuid;
