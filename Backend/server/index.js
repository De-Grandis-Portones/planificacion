const path = require('path');

// USE_LOCAL_DB (seteado por dev-local.js, nunca en producción/Render) apunta
// a .env.local en vez de .env — misma variable SUPABASE_DB_URL, apuntando a
// la copia local en vez de Supabase real. Sin USE_LOCAL_DB, comportamiento
// idéntico a siempre.
require('dotenv').config({
  path: path.join(__dirname, '..', process.env.USE_LOCAL_DB ? '.env.local' : '.env'),
});

const { app } = require('./app');
const { pool } = require('./db');
const { startInsumosScheduler, runDailyClose } = require('./lib/insumosScheduler');

const PORT = process.env.PORT || 4000;

// Migraciones aditivas — seguras de correr en cada inicio (IF NOT EXISTS).
// Agregar nuevas migraciones al final del array; nunca modificar las existentes.
const MIGRATIONS = [
  {
    name: 'refabricacion_columns',
    sql: `
      ALTER TABLE public.portones
        ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'normal',
        ADD COLUMN IF NOT EXISTS parent_id INTEGER,
        ADD COLUMN IF NOT EXISTS revision_ok BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS detalle_refabricacion TEXT;
    `,
  },
  {
    name: 'refabricacion_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_portones_parent_id ON public.portones(parent_id);
      CREATE INDEX IF NOT EXISTS idx_portones_tipo ON public.portones(tipo);
    `,
  },
  {
    name: 'refabricacion_revision_ok_at',
    sql: `
      ALTER TABLE public.portones
        ADD COLUMN IF NOT EXISTS revision_ok_at TIMESTAMPTZ;
    `,
  },
  {
    name: 'fix_nv_nlista_partial_unique',
    sql: `
      ALTER TABLE public.portones DROP CONSTRAINT IF EXISTS portones_nv_nlista_uniq;
      CREATE UNIQUE INDEX IF NOT EXISTS portones_nv_nlista_normal_uniq
        ON public.portones(nv, nlista)
        WHERE tipo = 'normal';
    `,
  },
  {
    // GET /portones (server/routes/public/portones.js) hace un LEFT JOIN
    // LATERAL contra presupuestador_quotes para resolver el nombre del
    // cliente. Sin estos índices, cada uno de los ~430 portones escaneaba
    // casi toda la tabla de quotes: la consulta pasó de ~1.2s a ~35-50ms.
    name: 'idx_presupuestador_quotes_sale_order_name',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_pq_final_sale_order_name_original
        ON public.presupuestador_quotes (final_sale_order_name, id)
        WHERE quote_kind = 'original';
      CREATE INDEX IF NOT EXISTS idx_pq_odoo_sale_order_name_original
        ON public.presupuestador_quotes (odoo_sale_order_name, id)
        WHERE quote_kind = 'original';
    `,
  },
  {
    name: 'fix_parent_id_to_uuid',
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'portones'
            AND column_name = 'parent_id' AND data_type = 'integer'
        ) THEN
          ALTER TABLE public.portones DROP COLUMN parent_id;
          ALTER TABLE public.portones ADD COLUMN parent_id UUID;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'portones'
            AND column_name = 'parent_id'
        ) THEN
          ALTER TABLE public.portones ADD COLUMN parent_id UUID;
        END IF;
      END $$;
    `,
  },
  {
    // Cache de coordenadas resueltas a partir de end_customer.maps_url (Mapa
    // de portones por semana/viaje en Logística de Viajes y Planificación de
    // Fechas). presupuestador_quotes es tabla del Presupuestador, pero Planta
    // ya lee/escribe directo ahí (preproduccion.js, logisticaConsultasDb.js) -
    // mismo patrón. Ver server/lib/geocoding.js y server/lib/logisticaMapa.js.
    name: 'presupuestador_quotes_geo_cols',
    sql: `
      ALTER TABLE public.presupuestador_quotes
        ADD COLUMN IF NOT EXISTS geo_lat DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS geo_lng DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS geo_source TEXT,
        ADD COLUMN IF NOT EXISTS geo_updated_at TIMESTAMPTZ;
    `,
  },
  {
    // Zonas que una RUTA (no un portón individual) atraviesa - pedido del
    // usuario: un viaje a Bahía Blanca puede "pasar por" Santa Fe o Gral
    // Pico sin tener ninguna parada ahí, detectado por el corredor entre
    // depósito/paradas (ver server/lib/logisticaRutaZonas.js), no por la
    // clasificación de zona de cada portón (esa sigue igual, es otra cosa).
    // habilitada = para una integración futura con el Presupuestador (avisar
    // cupo de entrega disponible en una zona si el viaje llega antes que la
    // producción) - se guarda ya, se usa después.
    name: 'logistica_viaje_zonas',
    sql: `
      CREATE TABLE IF NOT EXISTS public.logistica_viaje_zonas (
        viaje_id INTEGER NOT NULL REFERENCES public.logistica_viajes(id) ON DELETE CASCADE,
        zona_id INTEGER NOT NULL REFERENCES public.logistica_zonas(id) ON DELETE CASCADE,
        habilitada BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (viaje_id, zona_id)
      );
    `,
  },
  {
    // Zona dibujada a mano en el mapa (polígono) en vez de (o además de)
    // localidades de referencia - pedido del usuario ("pintar zonas a
    // gusto"). [[lat,lng], ...] en orden, sin cerrar el anillo (el primer y
    // último punto no se repiten). Si una zona tiene polígono, la
    // clasificación usa "¿el punto cae adentro?" antes que "referencia más
    // cercana" (logisticaZonificacion.js) - compatible con las zonas viejas
    // que solo tienen referencias, esas siguen funcionando igual.
    name: 'logistica_zonas_poligono',
    sql: `
      ALTER TABLE public.logistica_zonas
        ADD COLUMN IF NOT EXISTS poligono JSONB;
    `,
  },
  {
    // Paradas que no son un portón - pedido del usuario, ej. alojamiento de
    // la cuadrilla en un viaje largo. Catálogo reutilizable (logistica_
    // puntos_extra: nombre + maps_url + coords ya resueltas, ej. "Hotel San
    // Vicente") para no volver a pegar la misma URL cada vez - y una tabla
    // de asignación por viaje (logistica_viaje_paradas_extra) con `orden` en
    // el MISMO espacio numérico que logistica_viaje_portones.orden, para
    // poder mezclar portones y paradas extra en una sola secuencia de ruta.
    name: 'logistica_puntos_extra',
    sql: `
      CREATE TABLE IF NOT EXISTS public.logistica_puntos_extra (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        maps_url TEXT NOT NULL,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.logistica_viaje_paradas_extra (
        id SERIAL PRIMARY KEY,
        viaje_id INTEGER NOT NULL REFERENCES public.logistica_viajes(id) ON DELETE CASCADE,
        punto_extra_id INTEGER NOT NULL REFERENCES public.logistica_puntos_extra(id) ON DELETE CASCADE,
        orden INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (viaje_id, punto_extra_id)
      );
    `,
  },
  {
    // Ruta REAL por calle (no línea recta) - pedido del usuario: "que la
    // ruta respete las rutas reales, donde se mueve el camión". Se calcula
    // con OpenRouteService (perfil driving-hgv, camión de carga - más
    // realista que auto para portones) y se cachea acá: geometría +
    // distancia/duración reales, recalculada solo cuando cambian las
    // paradas/el orden de la ruta (mismo trigger que las zonas del
    // corredor, ver server/lib/logisticaRuteo.js).
    name: 'logistica_viajes_ruta_real',
    sql: `
      ALTER TABLE public.logistica_viajes
        ADD COLUMN IF NOT EXISTS ruta_real JSONB;
    `,
  },
  {
    // Hora de salida del viaje (ademas de la fecha) - pedido del usuario:
    // con esto + los tiempos reales por tramo que ya devuelve OpenRouteService
    // (ruta_real ahora tambien guarda segmentos_horas, uno por tramo entre
    // paradas consecutivas) se calcula el horario estimado de llegada a
    // cada parada.
    name: 'logistica_viajes_hora_salida',
    sql: `
      ALTER TABLE public.logistica_viajes
        ADD COLUMN IF NOT EXISTS hora_salida TIME;
    `,
  },
  {
    // Pedido del usuario: una parada extra de descanso (hotel) puede tener
    // su PROPIO horario de salida, que se aplica al DÍA SIGUIENTE de llegar
    // ahí - la ruta "retoma" desde ese horario en vez de seguir acumulando
    // desde la hora_salida original del viaje. Vive en la asignación
    // viaje<->parada (no en el catálogo logistica_puntos_extra): el mismo
    // hotel puede usarse en otro viaje con un horario de salida distinto.
    name: 'logistica_viaje_paradas_extra_hora_salida_siguiente',
    sql: `
      ALTER TABLE public.logistica_viaje_paradas_extra
        ADD COLUMN IF NOT EXISTS hora_salida_siguiente TIME,
        ADD COLUMN IF NOT EXISTS duracion_minutos INTEGER;
    `,
  },
  {
    // Adjuntos de Logística (DNI, certificado de reincidencia que piden
    // algunos countrys, etc.) - pedido del usuario: "a las rutas y/o los
    // portones". El archivo en sí vive en Supabase Storage (bucket privado
    // "logistica-adjuntos", ver lib/logisticaAdjuntosStorage.js) - acá solo
    // la metadata + el path para poder pedirlo/borrarlo.
    name: 'logistica_adjuntos',
    sql: `
      CREATE TABLE IF NOT EXISTS public.logistica_adjuntos (
        id SERIAL PRIMARY KEY,
        viaje_id INTEGER REFERENCES public.logistica_viajes(id) ON DELETE CASCADE,
        nv INTEGER,
        nombre_archivo TEXT NOT NULL,
        descripcion TEXT,
        tipo_mime TEXT NOT NULL,
        tamano_bytes INTEGER,
        storage_path TEXT NOT NULL,
        subido_por TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT logistica_adjuntos_viaje_o_nv CHECK (viaje_id IS NOT NULL OR nv IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_logistica_adjuntos_viaje ON public.logistica_adjuntos(viaje_id);
      CREATE INDEX IF NOT EXISTS idx_logistica_adjuntos_nv ON public.logistica_adjuntos(nv);
    `,
  },
  {
    // /despacho_v2 (mobile, login de cuadrilla): botón "Play" para marcar la
    // hora REAL de salida (distinto de hora_salida, que es la planificada) -
    // pedido del usuario: "que quede asentado a qué hora se salió realmente".
    name: 'logistica_viajes_hora_salida_real',
    sql: `
      ALTER TABLE public.logistica_viajes
        ADD COLUMN IF NOT EXISTS hora_salida_real TIMESTAMPTZ;
    `,
  },
  {
    // "Calidad"/rol por integrante de cuadrilla (ej. "Chofer") - pedido del
    // usuario para el mensaje de WhatsApp automático de /despacho_v2 ("La
    // cuadrilla... Nombre / Calidad: Chofer"). Configurable en el ABM de
    // cuadrillas (LogisticaCuadrillasModal.jsx).
    name: 'logistica_cuadrilla_miembros_rol',
    sql: `
      ALTER TABLE public.logistica_cuadrilla_miembros
        ADD COLUMN IF NOT EXISTS rol TEXT;
    `,
  },
  {
    // Catálogo de adjuntos POR INTEGRANTE de cuadrilla (ej. el DNI) - pedido
    // del usuario: se sube UNA vez en la cuadrilla, y de ahí se puede
    // "habilitar" (sin volver a subirlo) para un viaje y/o un NV puntual.
    // origen_miembro_id en logistica_adjuntos marca esas filas "habilitadas"
    // - comparten storage_path con el catálogo, así que al borrar una fila
    // habilitada NO se borra el archivo real (solo cuando se borra el
    // catálogo en sí, que se lleva puestas en cascada las habilitaciones).
    name: 'logistica_adjuntos_miembro',
    sql: `
      CREATE TABLE IF NOT EXISTS public.logistica_adjuntos_miembro (
        id SERIAL PRIMARY KEY,
        qc_user_id INTEGER NOT NULL REFERENCES public.qc_users(id) ON DELETE CASCADE,
        nombre_archivo TEXT NOT NULL,
        descripcion TEXT,
        tipo_mime TEXT NOT NULL,
        tamano_bytes INTEGER,
        storage_path TEXT NOT NULL,
        subido_por TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_logistica_adjuntos_miembro_qc_user ON public.logistica_adjuntos_miembro(qc_user_id);
      ALTER TABLE public.logistica_adjuntos
        ADD COLUMN IF NOT EXISTS origen_miembro_id INTEGER REFERENCES public.logistica_adjuntos_miembro(id) ON DELETE CASCADE;
    `,
  },
  {
    // Sistema de tickets: un botón "Tickets" (junto a "Menú" en las pantallas
    // admin, y junto a "Refrescar" en los tableros de producción) permite a
    // cualquier admin logueado abrir un ticket (categoría + texto libre); se
    // ven y responden todos desde /admin/tickets. Tablas propias de esta app
    // (no las de "Consultas de Logística", que apuntan a tablas del
    // Presupuestador).
    name: 'tickets',
    sql: `
      CREATE TABLE IF NOT EXISTS public.tickets (
        id SERIAL PRIMARY KEY,
        categoria TEXT NOT NULL,
        mensaje TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pending',
        creado_por_id INTEGER REFERENCES public.admin_users(id),
        creado_por_username TEXT,
        ruta_origen TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_estado ON public.tickets(estado);
      CREATE INDEX IF NOT EXISTS idx_tickets_creado_por ON public.tickets(creado_por_id);
    `,
  },
  {
    name: 'ticket_mensajes',
    sql: `
      CREATE TABLE IF NOT EXISTS public.ticket_mensajes (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
        autor_id INTEGER REFERENCES public.admin_users(id),
        autor_username TEXT,
        es_admin BOOLEAN NOT NULL DEFAULT FALSE,
        mensaje TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_mensajes_ticket ON public.ticket_mensajes(ticket_id);
    `,
  },
  {
    // Los tickets pasan a ser el almacén CENTRAL de todas las apps del
    // ecosistema (primero planificación, ahora integrador, después el
    // resto) — no solo de planificación. creado_por_id/autor_id ya no
    // pueden tener FK a admin_users: un usuario de otra app no existe en
    // esa tabla. app_origen dice de qué app vino cada ticket para poder
    // filtrar/identificar en /admin/tickets.
    name: 'tickets_multi_app',
    sql: `
      ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_creado_por_id_fkey;
      ALTER TABLE public.ticket_mensajes DROP CONSTRAINT IF EXISTS ticket_mensajes_autor_id_fkey;
      ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS app_origen TEXT NOT NULL DEFAULT 'planificacion';
      CREATE INDEX IF NOT EXISTS idx_tickets_app_origen ON public.tickets(app_origen);
    `,
  },
  {
    // creado_por_id/autor_id eran INTEGER (id numerico de admin_users de
    // planificacion). Integrador identifica usuarios con un UUID de
    // Supabase Auth, no un numero — pasan a TEXT para que cualquier app
    // pueda guardar el id que tenga, sea cual sea su forma.
    name: 'tickets_creado_por_id_text',
    sql: `
      ALTER TABLE public.tickets ALTER COLUMN creado_por_id TYPE TEXT USING creado_por_id::text;
      ALTER TABLE public.ticket_mensajes ALTER COLUMN autor_id TYPE TEXT USING autor_id::text;
    `,
  },
  {
    // Adjuntos en el ticket inicial (imagen/PDF/video) — mismo formato que ya
    // usan las Consultas a Técnica/Comercial del Presupuestador y las
    // Consultas de Logística: array de { name, type, size, data_url,
    // uploaded_at } en JSONB. Ver Frontend/src/utils/ticketAttachment.js.
    name: 'tickets_adjuntos',
    sql: `
      ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS adjuntos JSONB NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    // Foto de perfil por integrante (qc_users - es genérico a la persona,
    // no solo a logística) y foto del vehículo - pedido del usuario: van en
    // el collage del mensaje automático de WhatsApp ("en camino"). Una sola
    // foto cada uno (no un catálogo como el DNI) - alcanza para el collage.
    name: 'logistica_fotos_perfil_vehiculo',
    sql: `
      ALTER TABLE public.qc_users
        ADD COLUMN IF NOT EXISTS foto_storage_path TEXT;
      ALTER TABLE public.logistica_vehiculos
        ADD COLUMN IF NOT EXISTS foto_storage_path TEXT;
    `,
  },
  {
    // Botón "Marcar entregado/instalado" de /despacho_v2 (cierre OFICIAL de
    // esa etapa, mismo mecanismo de PIN que /qc/authorize) + aviso automático
    // de WhatsApp Business a la siguiente parada de la ruta, con collage de
    // fotos (cuadrilla + vehículo) armado al momento de mandar - pedido
    // explícito del usuario. Log de qué se mandó y cuándo, para no volver a
    // mandarlo dos veces sin querer y para poder auditar/depurar envíos.
    name: 'logistica_whatsapp_avisos',
    sql: `
      CREATE TABLE IF NOT EXISTS public.logistica_whatsapp_avisos (
        id SERIAL PRIMARY KEY,
        viaje_id INTEGER NOT NULL REFERENCES public.logistica_viajes(id) ON DELETE CASCADE,
        nv_origen INTEGER NOT NULL,
        nv_destino INTEGER NOT NULL,
        telefono_destino TEXT,
        estado TEXT NOT NULL DEFAULT 'enviado',
        detalle_error TEXT,
        wa_message_id TEXT,
        enviado_por TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_logistica_whatsapp_avisos_viaje ON public.logistica_whatsapp_avisos(viaje_id);
    `,
  },
  {
    // Gastos de viaje ("rendición de gastos") cargados por la cuadrilla
    // desde /despacho_v2 - pedido explícito del usuario: fecha + motivo
    // (Refrigerio/Hospedaje/Otros por ahora, catálogo simple en el frontend
    // - "después vamos a agregar más motivos") + monto + el ticket adjunto
    // (foto o PDF). Una "rendición" no tiene tabla propia: es, ni más ni
    // menos, el conjunto de gastos de UN viaje (se arma agregando por
    // viaje_id en logisticaGastosDb.listRendiciones). El campo de auditoría
    // ("ya fue controlada") queda para una vuelta futura, pedido explícito
    // del usuario.
    name: 'logistica_gastos',
    sql: `
      CREATE TABLE IF NOT EXISTS public.logistica_gastos (
        id SERIAL PRIMARY KEY,
        viaje_id INTEGER NOT NULL REFERENCES public.logistica_viajes(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        motivo TEXT NOT NULL,
        monto NUMERIC(12,2) NOT NULL,
        storage_path TEXT NOT NULL,
        nombre_archivo TEXT,
        tipo_mime TEXT,
        cargado_por TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_logistica_gastos_viaje ON public.logistica_gastos(viaje_id);
    `,
  },
  {
    // Sistema de tickets: un botón "Tickets" (junto a "Menú" en las pantallas
    // admin, y junto a "Refrescar" en los tableros de producción) permite a
    // cualquier admin logueado abrir un ticket (categoría + texto libre); se
    // ven y responden todos desde /admin/tickets. Tablas propias de esta app
    // (no las de "Consultas de Logística", que apuntan a tablas del
    // Presupuestador).
    name: 'tickets',
    sql: `
      CREATE TABLE IF NOT EXISTS public.tickets (
        id SERIAL PRIMARY KEY,
        categoria TEXT NOT NULL,
        mensaje TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pending',
        creado_por_id INTEGER REFERENCES public.admin_users(id),
        creado_por_username TEXT,
        ruta_origen TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_estado ON public.tickets(estado);
      CREATE INDEX IF NOT EXISTS idx_tickets_creado_por ON public.tickets(creado_por_id);
    `,
  },
  {
    name: 'ticket_mensajes',
    sql: `
      CREATE TABLE IF NOT EXISTS public.ticket_mensajes (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
        autor_id INTEGER REFERENCES public.admin_users(id),
        autor_username TEXT,
        es_admin BOOLEAN NOT NULL DEFAULT FALSE,
        mensaje TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_mensajes_ticket ON public.ticket_mensajes(ticket_id);
    `,
  },
  {
    // Los tickets pasan a ser el almacén CENTRAL de todas las apps del
    // ecosistema (primero planificación, ahora integrador, después el
    // resto) — no solo de planificación. creado_por_id/autor_id ya no
    // pueden tener FK a admin_users: un usuario de otra app no existe en
    // esa tabla. app_origen dice de qué app vino cada ticket para poder
    // filtrar/identificar en /admin/tickets.
    name: 'tickets_multi_app',
    sql: `
      ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_creado_por_id_fkey;
      ALTER TABLE public.ticket_mensajes DROP CONSTRAINT IF EXISTS ticket_mensajes_autor_id_fkey;
      ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS app_origen TEXT NOT NULL DEFAULT 'planificacion';
      CREATE INDEX IF NOT EXISTS idx_tickets_app_origen ON public.tickets(app_origen);
    `,
  },
  {
    // creado_por_id/autor_id eran INTEGER (id numerico de admin_users de
    // planificacion). Integrador identifica usuarios con un UUID de
    // Supabase Auth, no un numero — pasan a TEXT para que cualquier app
    // pueda guardar el id que tenga, sea cual sea su forma.
    name: 'tickets_creado_por_id_text',
    sql: `
      ALTER TABLE public.tickets ALTER COLUMN creado_por_id TYPE TEXT USING creado_por_id::text;
      ALTER TABLE public.ticket_mensajes ALTER COLUMN autor_id TYPE TEXT USING autor_id::text;
    `,
  },
  {
    // Adjuntos en el ticket inicial (imagen/PDF/video) — mismo formato que ya
    // usan las Consultas a Técnica/Comercial del Presupuestador y las
    // Consultas de Logística: array de { name, type, size, data_url,
    // uploaded_at } en JSONB. Ver Frontend/src/utils/ticketAttachment.js.
    name: 'tickets_adjuntos',
    sql: `
      ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS adjuntos JSONB NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    // Link editable por cuadro del diagrama "Índice de Programación" (ver
    // server/sql/migration_notas_nodo*.sql) - pedido del usuario: poder
    // guardar una URL de referencia (repo, doc, tablero) junto con la nota y
    // el acceso de cada nodo, visible para todo el equipo.
    name: 'notas_nodo_link',
    sql: `
      CREATE TABLE IF NOT EXISTS public.notas_nodo (
        nodo_id TEXT PRIMARY KEY,
        nota TEXT NOT NULL DEFAULT '',
        admin_user TEXT NOT NULL DEFAULT '',
        admin_password TEXT NOT NULL DEFAULT '',
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.notas_nodo ADD COLUMN IF NOT EXISTS link TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // En algunos entornos locales notas_nodo ya existía (creada a mano solo
    // con migration_notas_nodo.sql, sin correr nunca
    // migration_notas_nodo_credenciales.sql ni
    // migration_notas_nodo_usuarios_prueba.sql) - el CREATE TABLE IF NOT
    // EXISTS de arriba es un no-op en ese caso y deja faltando estas
    // columnas/tabla. Estas dos ALTER/CREATE son additivas e idempotentes,
    // así que no rompen nada donde ya estaban corridas a mano.
    name: 'notas_nodo_credenciales_y_usuarios_prueba',
    sql: `
      ALTER TABLE public.notas_nodo
        ADD COLUMN IF NOT EXISTS admin_user TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS admin_password TEXT NOT NULL DEFAULT '';

      CREATE TABLE IF NOT EXISTS public.notas_nodo_usuarios_prueba (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nodo_id TEXT NOT NULL,
        etiqueta TEXT NOT NULL DEFAULT '',
        usuario TEXT NOT NULL,
        password TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS notas_nodo_usuarios_prueba_nodo_id_idx
        ON public.notas_nodo_usuarios_prueba (nodo_id, created_at);
    `,
  },
  {
    // "¿Qué se está trabajando acá?" pasa de un solo campo compartido
    // (notas_nodo.nota, "gana el último que guarda") a una fila POR ADMIN:
    // así dos personas escribiendo al mismo tiempo en el mismo nodo nunca se
    // pisan - cada quien edita y borra solo la suya. notas_nodo.nota queda
    // sin usar por esta pantalla (no se borra la columna, por si acaso).
    name: 'notas_nodo_entradas',
    sql: `
      CREATE TABLE IF NOT EXISTS public.notas_nodo_entradas (
        nodo_id TEXT NOT NULL,
        autor_username TEXT NOT NULL,
        texto TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (nodo_id, autor_username)
      );
      CREATE INDEX IF NOT EXISTS idx_notas_nodo_entradas_nodo
        ON public.notas_nodo_entradas (nodo_id, updated_at);
    `,
  },
  {
    // Todas las consultas de tickets (listMyTickets, listAllTickets) ordenan
    // por created_at desc y no había índice para eso - quedaba resuelto con
    // un sort completo de la tabla en cada pedido. No afecta hoy con el
    // volumen actual, pero es gratis agregarlo ahora.
    name: 'tickets_created_at_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON public.tickets (created_at DESC);
    `,
  },
  {
    // Las tarjetas "tarea" (creadas a mano desde /admin/tickets-tablero, no
    // mandadas por ninguna app - ver app_origen='tarea') se pueden arrastrar
    // a CUALQUIER columna del tablero, no solo Cerrados/su propia columna
    // como un ticket real. app_origen se queda fijo en 'tarea' siempre (así
    // se sabe que es libre de mover/borrar en cualquier estado);
    // board_column guarda en qué columna se ve HOY. NULL para cualquier
    // ticket real (esos siempre se pintan por su app_origen, sin esta
    // columna).
    name: 'tickets_board_column',
    sql: `
      ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS board_column TEXT;
    `,
  },
  {
    // "Apartados": columnas EXTRA del tablero (/admin/tickets-tablero) que
    // un admin puede crear a mano ("+ Nuevo apartado"), además de las fijas
    // (una por app + "Tareas" + "Cerrados"). `clave` es lo que se guarda en
    // tickets.board_column para ubicar ahí una tarjeta "tarea"; `nombre` es
    // el título que se ve en el header de la columna.
    name: 'ticket_board_apartados',
    sql: `
      CREATE TABLE IF NOT EXISTS public.ticket_board_apartados (
        id SERIAL PRIMARY KEY,
        clave TEXT UNIQUE NOT NULL,
        nombre TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // "¿Quién lo está trabajando ahora?" - se pisa con el username de quien
    // pone el ticket/tarea en "En curso" (PATCH .../status), se limpia si
    // vuelve a "Pendiente", y se conserva al cerrarlo (queda como "quién lo
    // resolvió"). Ver ticketsDb.setEstado.
    name: 'tickets_en_progreso_por',
    sql: `
      ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS en_progreso_por TEXT;
    `,
  },
  {
    // Bandeja de WhatsApp Business: TODOS los mensajes (entrantes por webhook
    // + salientes desde la app) en una sola tabla, agrupados por teléfono,
    // para el chat tipo WhatsApp Web - pedido explícito del usuario. Ver
    // server/sql/migration_logistica_whatsapp_mensajes.sql (mismo contenido).
    name: 'logistica_whatsapp_mensajes',
    sql: `
      CREATE TABLE IF NOT EXISTS public.logistica_whatsapp_mensajes (
        id BIGSERIAL PRIMARY KEY,
        telefono TEXT NOT NULL,
        direccion TEXT NOT NULL CHECK (direccion IN ('entrante', 'saliente')),
        tipo TEXT NOT NULL DEFAULT 'text',
        contenido TEXT,
        media_id TEXT,
        wa_message_id TEXT,
        estado TEXT NOT NULL DEFAULT 'enviado',
        detalle_error TEXT,
        enviado_por TEXT,
        raw JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_logistica_whatsapp_mensajes_telefono ON public.logistica_whatsapp_mensajes (telefono, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_logistica_whatsapp_mensajes_wa_id ON public.logistica_whatsapp_mensajes (wa_message_id) WHERE wa_message_id IS NOT NULL;
    `,
  },
  {
    // Imagen/video/audio/documento entrante o saliente por el chat de
    // WhatsApp - path en Storage (mismo bucket que el collage), no la URL
    // temporal de Meta que expira en minutos.
    name: 'logistica_whatsapp_mensajes_media_storage_path',
    sql: `
      ALTER TABLE public.logistica_whatsapp_mensajes ADD COLUMN IF NOT EXISTS media_storage_path TEXT;
    `,
  },
  {
    // Nombre de contacto editable a mano - pedido explícito del usuario: el
    // nombre resuelto automático contra presupuestador_quotes a veces sale
    // mal (mezcla nombre + descripción de producto).
    name: 'logistica_whatsapp_contactos',
    sql: `
      CREATE TABLE IF NOT EXISTS public.logistica_whatsapp_contactos (
        telefono TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // Rendiciones con verificación por IA - pedido explícito del usuario.
    // hora_llegada_real: la marca "finalizar viaje" que le falta a
    // marcar-salida/hora_salida_real - define el fin del rango de fechas
    // válido para los gastos, y logística no puede aprobar la rendición
    // hasta que esté cargada. rendicion_aprobada_*: el "ok" final de
    // logística sobre TODOS los gastos del viaje.
    name: 'logistica_viajes_rendicion_aprobacion',
    sql: `
      ALTER TABLE public.logistica_viajes
        ADD COLUMN IF NOT EXISTS hora_llegada_real TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS rendicion_aprobada_por TEXT,
        ADD COLUMN IF NOT EXISTS rendicion_aprobada_at TIMESTAMPTZ;
    `,
  },
  {
    // Por gasto: qué leyó la IA del comprobante (tipo_comprobante,
    // medio_pago - este último ya pensado para la Parte 2, reconciliación
    // con Odoo/email) y si hizo falta revisión humana (estado_revision:
    // pendiente/ok/revisar) - campos_inciertos guarda CUÁLES campos no supo
    // resolver con confianza, para resaltarlos en la auditoría de logística.
    name: 'logistica_gastos_revision_ia',
    sql: `
      ALTER TABLE public.logistica_gastos
        ADD COLUMN IF NOT EXISTS tipo_comprobante TEXT,
        ADD COLUMN IF NOT EXISTS medio_pago TEXT,
        ADD COLUMN IF NOT EXISTS estado_revision TEXT NOT NULL DEFAULT 'pendiente',
        ADD COLUMN IF NOT EXISTS detalle_revision TEXT,
        ADD COLUMN IF NOT EXISTS campos_inciertos TEXT[];
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'logistica_gastos_estado_revision_check'
        ) THEN
          ALTER TABLE public.logistica_gastos
            ADD CONSTRAINT logistica_gastos_estado_revision_check
            CHECK (estado_revision IN ('pendiente','ok','revisar'));
        END IF;
      END $$;
    `,
  },
  {
    // Fondo de efectivo que logística le da a la cuadrilla al crear el
    // viaje (ej. para viáticos en efectivo) - pedido explícito del usuario.
    // El saldo a devolver se calcula como fondo_efectivo menos lo gastado en
    // efectivo (hoy: medio_pago='efectivo' según la IA del ticket; a futuro,
    // Parte 2 lo confirma contra el email de la tarjeta - lo que NO matchee
    // ahí también cuenta como efectivo).
    name: 'logistica_viajes_fondo_efectivo',
    sql: `
      ALTER TABLE public.logistica_viajes
        ADD COLUMN IF NOT EXISTS fondo_efectivo NUMERIC(12,2);
    `,
  },
  {
    // Checklist configurable que la cuadrilla debe completar (todo en "OK")
    // antes de poder arrancar un viaje en /despacho_v2 (pedido explícito del
    // usuario) - dos listas independientes según si el viaje tiene alguna
    // parada de instalación o es solo despacho. Se configura desde
    // /admin/logistica-fechas (panel de configuración); la confirmación de
    // cada viaje queda auditada con una copia (items_snapshot) de los ítems
    // tal como estaban configurados al momento de arrancar - si después se
    // edita/borra un ítem, el historial de viajes ya arrancados no cambia.
    name: 'logistica_checklist_items',
    sql: `
      CREATE TABLE IF NOT EXISTS public.logistica_checklist_items (
        id SERIAL PRIMARY KEY,
        tipo TEXT NOT NULL,
        texto TEXT NOT NULL,
        orden INTEGER NOT NULL DEFAULT 0,
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'logistica_checklist_items_tipo_check'
        ) THEN
          ALTER TABLE public.logistica_checklist_items
            ADD CONSTRAINT logistica_checklist_items_tipo_check
            CHECK (tipo IN ('solo_despacho','con_instalacion'));
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_logistica_checklist_items_tipo ON public.logistica_checklist_items(tipo);

      CREATE TABLE IF NOT EXISTS public.logistica_viaje_checklist_confirmaciones (
        id SERIAL PRIMARY KEY,
        viaje_id INTEGER NOT NULL REFERENCES public.logistica_viajes(id) ON DELETE CASCADE,
        tipo TEXT NOT NULL,
        items_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
        confirmado_por TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_logistica_viaje_checklist_confirmaciones_viaje ON public.logistica_viaje_checklist_confirmaciones(viaje_id);
    `,
  },
  {
    // "Reuniones y Tareas" (/admin/reuniones) - agenda simple para que los
    // admins carguen fecha/hora de reuniones entre ellos. Sin invitados/RSVP
    // (no se pidió) - un espacio compartido, cualquier admin ve/crea/edita,
    // mismo criterio "sin scope propio" que /admin/tickets.
    name: 'reuniones_admin',
    sql: `
      CREATE TABLE IF NOT EXISTS public.reuniones (
        id SERIAL PRIMARY KEY,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE NOT NULL,
        hora_inicio TIME NOT NULL,
        hora_fin TIME,
        enlace TEXT,
        creado_por TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_reuniones_fecha ON public.reuniones(fecha);
    `,
  },
];

async function runMigrations() {
  const client = await pool.connect();
  try {
    for (const m of MIGRATIONS) {
      console.log(`[migration] running: ${m.name}`);
      await client.query(m.sql);
      console.log(`[migration] ok: ${m.name}`);
    }
  } finally {
    client.release();
  }
}

process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});

runMigrations()
  .then(async () => {
    app.listen(PORT, () => {
      console.log(`Backend escuchando en http://localhost:${PORT}`);
    });
    startInsumosScheduler();
    // Catch-up: si el proceso se reinició después del horario de cierre de
    // alguna sección (configurable, ver insumosSeccionCierreDb.js), cierra ya
    // lo que quedó abierto en vez de esperar al próximo tick del cron.
    try {
      await runDailyClose();
    } catch (err) {
      console.error('[insumos] catch-up al arrancar falló:', err.message);
    }
  })
  .catch((err) => {
    console.error('[migration] ERROR — el servidor no arrancó:', err.message);
    process.exit(1);
  });
