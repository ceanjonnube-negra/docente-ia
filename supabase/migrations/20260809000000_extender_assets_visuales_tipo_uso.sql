-- Fase 2A — documentos ilustrados (ver "Documentos ilustrados + guías
-- completas e ilustradas"). Extensión 100% aditiva de assets_visuales
-- (creada en 20260808210000_crear_assets_visuales.sql) — no se toca
-- ninguna columna existente, no se modifica RLS, no se crea tabla
-- nueva.
--
-- tipo_uso distingue una imagen suelta (chat) de una ilustración
-- embebida dentro de un documento Word/PDF — 'suelta' es el default
-- explícito para que las filas ya existentes de Fase 0+1 (todas
-- imágenes sueltas) queden correctamente clasificadas sin backfill.
-- orden_en_documento es la posición de esa ilustración dentro del
-- documento que la usa (null para imágenes sueltas).

alter table public.assets_visuales
  add column if not exists tipo_uso text not null default 'suelta'
    check (tipo_uso in ('suelta', 'ilustracion_documento', 'portada', 'actividad', 'apoyo', 'colorear'));

alter table public.assets_visuales
  add column if not exists orden_en_documento integer;

-- Rollback documentado (nunca ejecutado automáticamente):
-- alter table public.assets_visuales drop column if exists orden_en_documento;
-- alter table public.assets_visuales drop column if exists tipo_uso;
