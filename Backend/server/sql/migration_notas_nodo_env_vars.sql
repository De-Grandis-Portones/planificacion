-- Suma variables de entorno e información de programación editables a
-- public.notas_nodo (ver migration_notas_nodo.sql), para poder guardar por
-- cuadro del diagrama "Índice de Programación" el .env de esa app y notas
-- técnicas relevantes, visibles para todo el equipo.
-- Correr a mano contra la base (Supabase), igual que el resto de server/sql/*.sql.

alter table public.notas_nodo
  add column if not exists env_vars text not null default '',
  add column if not exists info_programacion text not null default '';
