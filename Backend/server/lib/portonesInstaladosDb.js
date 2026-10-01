// lib/portonesInstaladosDb.js
//
// Padrón de portones instalados en clientes finales (pedido de Esteban,
// 2026-10-01): dirección de instalación con link de Google Maps, NV y tipo de
// portón (sistema, colores, tipo y orientación del revestimiento, lucera,
// puerta), para todos los canales (venta directa y por distribuidor).
//
// SOLO LECTURA: un único SELECT, sin escrituras de ningún tipo. A propósito NO
// se usa logisticaMapa.resolveCoordsForNvs: esa función cachea coordenadas con
// un UPDATE sobre presupuestador_quotes. Acá las coordenadas salen del propio
// link (extractCoordsFromMapsUrl, sin red) o del caché que Logística ya guardó
// (geo_lat/geo_lng), que solo se lee.
//
// Universo: una fila por NV de portón en preproduccion_valores (la tabla con
// más cobertura; el tablero de planta arrancó en marzo 2026 y solo tiene las NV
// activas desde entonces). Su columna data trae 2 formatos:
//   * "Sistema anterior": claves de planta (Nombre, Direccion, RazSoc,
//     ID_cliente, Sistema, Color, Lucera, PUERTA_Posicion, Descripcion).
//   * "Presupuestador": además cliente_*, vendido_por_rol, distribuidor_nombre y
//     las secciones del cotizador (section__*), que son los datos más limpios.
// Para cada dato se toma primero la fuente más confiable y después las demás.
const { pool } = require('../db');
const { extractCoordsFromMapsUrl } = require('./geocoding');

// String.raw: el SQL tiene muchas regex de Postgres (\d, \s, \m...) y así no
// hay que duplicar cada barra invertida.
const PORTONES_INSTALADOS_SQL = String.raw`
with pv as (
  select p.nv, p.data d, (p.data ? 'cliente_direccion') as es_presupuestador
  from public.preproduccion_valores p
  where p.nv_tipo = 'NV'
    and coalesce(lower(trim(p.data->>'Tipo')), '') not in ('ipanel', 'puerta')
),
-- En el sistema anterior el titular de la cuenta (RazSoc) viene cargado solo en
-- algunas NV: se propaga a todas las NV de la misma cuenta (ID_cliente).
cuentas as (
  select trim(d->>'ID_cliente') as id_cliente, max(nullif(trim(d->>'RazSoc'), '')) as razsoc
  from pv
  where nullif(trim(d->>'ID_cliente'), '') is not null
  group by 1
),
-- Presupuesto original de cada NV (fallback de cliente/dirección/canal). El
-- prefijo de la orden no siempre es "NV" (NP/INP/...), pero el número sí.
quotes as (
  select distinct on (nv) *
  from (
    select substring(coalesce(nullif(q.final_sale_order_name, ''), q.odoo_sale_order_name) from '\d+')::int as nv,
           q.end_customer, q.created_by_role, q.fulfillment_mode, q.created_at,
           q.geo_lat, q.geo_lng, q.geo_source
    from public.presupuestador_quotes q
    where q.quote_kind = 'original' and q.catalog_kind = 'porton'
      and coalesce(nullif(q.final_sale_order_name, ''), q.odoo_sale_order_name) ~ '\d'
  ) x
  order by nv, created_at desc
),
tablero as (
  select distinct on (p.nv) p.nv, p.sistema, p.fecha_nv, e.estado as despacho
  from public.portones p
  left join public.porton_etapas_estado e on e.porton_id = p.id and e.etapa = 'despacho'
  where p.tipo = 'normal'
  order by p.nv, p.id desc
),
base as (
  select
    pv.nv,
    case when pv.es_presupuestador then 'Presupuestador' else 'Sistema anterior' end as origen_dato,
    coalesce(
      t.fecha_nv,
      case when d->>'Fecha_NV' ~ '^\d{2}-\d{2}-\d{4}$' then to_date(d->>'Fecha_NV', 'DD-MM-YYYY') end,
      case when d->>'Fecha_NV' ~ '^\d{4}-\d{2}-\d{2}' then left(d->>'Fecha_NV', 10)::date end
    ) as fecha_nv,
    -- En el Presupuestador el "nombre" muchas veces ya trae el apellido, y
    -- cliente_nombre_completo (nombre + apellido) lo repite: "Maria Rios Rios".
    -- Si el nombre ya termina con el apellido, se usa el nombre solo.
    nullif(regexp_replace(trim(coalesce(
      case when nullif(trim(d->>'cliente_apellido'), '') is not null
            and right(lower(trim(d->>'cliente_nombre')), length(trim(d->>'cliente_apellido'))) = lower(trim(d->>'cliente_apellido'))
           then nullif(trim(d->>'cliente_nombre'), '') end,
      nullif(trim(d->>'cliente_nombre_completo'), ''),
      nullif(trim(d->>'Nombre'), ''),
      case when nullif(trim(q.end_customer->>'last_name'), '') is not null
            and right(lower(trim(q.end_customer->>'first_name')), length(trim(q.end_customer->>'last_name'))) = lower(trim(q.end_customer->>'last_name'))
           then nullif(trim(q.end_customer->>'first_name'), '') end,
      q.end_customer->>'name'
    )), '\s+', ' ', 'g'), '') as cliente,
    -- Canal: venta directa (vendedor / cuentas propias "DE GRANDIS PORTONES ..")
    -- o por distribuidor (el distribuidor es el titular de la cuenta).
    coalesce(nullif(trim(d->>'RazSoc'), ''), c.razsoc) as razsoc_cuenta,
    nullif(trim(d->>'ID_cliente'), '') as id_cuenta,
    coalesce(nullif(trim(d->>'vendido_por_rol'), ''), q.created_by_role) as rol_vendedor,
    nullif(trim(d->>'distribuidor_nombre'), '') as distribuidor_nombre,
    nullif(regexp_replace(trim(coalesce(
      nullif(concat_ws(', ', nullif(trim(d->>'cliente_direccion'), ''), nullif(trim(d->>'cliente_localidad'), '')), ''),
      nullif(trim(d->>'Direccion'), ''),
      nullif(concat_ws(', ', nullif(trim(q.end_customer->>'address'), ''), nullif(trim(q.end_customer->>'city'), '')), '')
    )), '\s+', ' ', 'g'), '') as direccion,
    coalesce(
      nullif(trim(d->>'cliente_maps_url'), ''),
      nullif(trim(d->>'pq_maps_url'), ''),
      nullif(trim(d->>'logistica_maps_url'), ''),
      nullif(trim(d->>'pp_direccion_url'), ''),
      nullif(trim(q.end_customer->>'maps_url'), '')
    ) as maps_url_cargado,
    upper(regexp_replace(trim(coalesce(
      nullif(trim(d->>'porton_type'), ''),
      nullif(trim(d->>'Sistema'), ''),
      t.sistema
    )), '[-\s]+', ' ', 'g')) as sistema,
    nullif(trim(d->>'section__tipo_de_sistema_de_porton'), '') as sistema_variante,
    regexp_replace(coalesce(
      nullif(trim(d->>'section__color_del_sistema_estructura'), ''),
      nullif(trim(d->>'section__color_de_sistema'), ''),
      nullif(trim(d->>'section__color_de_estructura_marco'), ''),
      nullif(trim(d->>'Color_Sistema'), '')
    ), '^Sistema( color)?\s+', '', 'i') as color_sistema,
    -- Color = 'SISTEMA' solo aparece en portones para revestir: no hay color de
    -- revestimiento de fábrica, el único color es el del sistema.
    case when upper(trim(d->>'Color')) = 'SISTEMA' and nullif(trim(d->>'Color_Hoja'), '') is null
         then 'Color del sistema'
         else regexp_replace(coalesce(
           nullif(trim(d->>'section__color_del_revestimiento_simil_aluminio'), ''),
           nullif(trim(d->>'section__color_del_revestimiento_simil_madera_otros'), ''),
           nullif(trim(d->>'section__color_del_revestimiento'), ''),
           nullif(trim(d->>'section__color_madera'), ''),
           nullif(trim(d->>'Color_Hoja'), ''),
           nullif(trim(d->>'Color'), '')
         ), '^Revest color\s+', '', 'i')
    end as color_revestimiento,
    -- Presupuestador: sección del cotizador. Sistema anterior: el primer tramo
    -- de Descripcion es el material (ALUMINIO / PVC / MADERA / SIMIL ROBLE ...).
    -- OJO: la clave "Revestimiento" del sistema anterior NO es el tipo, es quién
    -- lo provee ("De Grandis Portones" o el distribuidor) - no se usa.
    coalesce(
      nullif(concat_ws(' - ', nullif(trim(d->>'section__tipo_de_revestimiento'), ''), nullif(trim(d->>'section__tipo_de_revestimiento_a_colocar'), '')), ''),
      nullif(upper(trim(split_part(d->>'Descripcion', '-', 1))), '')
    ) as tipo_revestimiento,
    initcap(regexp_replace(coalesce(
      nullif(trim(d->>'section__orientacion_del_revestimiento_en_lamas'), ''),
      nullif(trim(d->>'section__orientacion_revestimiento'), ''),
      (regexp_match(d->>'Descripcion', '(REVESTIMIENTO|LAMAS?|VARILLADO|TABLILLAS?)[A-Z ]{0,15}?(VERTICAL|HORIZONTAL)', 'i'))[2]
    ), '^Orientaci[oó]n de Lamas:\s*|es$', '', 'gi')) as orientacion_revestimiento,
    coalesce(
      nullif(trim(d->>'section__lucera_para_vidrio'), ''),
      nullif(trim(d->>'section__lucera'), ''),
      nullif(trim(d->>'Lucera'), '')
    ) as lucera_raw,
    coalesce(
      nullif(trim(d->>'section__puerta_de_paso_peatonal'), ''),
      nullif(trim(d->>'section__puerta_de_escape'), ''),
      nullif(trim(d->>'PUERTA_Posicion'), '')
    ) as puerta_raw,
    coalesce(nullif(trim(d->>'fulfillment_mode'), ''), q.fulfillment_mode) as fulfillment_mode,
    t.nv is not null as en_tablero,
    t.despacho,
    case when q.geo_source is distinct from 'failed' then q.geo_lat end as geo_lat,
    case when q.geo_source is distinct from 'failed' then q.geo_lng end as geo_lng
  from pv
  left join cuentas c on c.id_cliente = trim(pv.d->>'ID_cliente')
  left join quotes q on q.nv = pv.nv
  left join tablero t on t.nv = pv.nv
),
final as (
  select
    b.*,
    case
      when b.rol_vendedor = 'vendedor' then 'Directo'
      when b.rol_vendedor = 'distribuidor' then 'Distribuidor'
      when b.razsoc_cuenta ilike 'DE GRANDIS%' then 'Directo'
      when b.razsoc_cuenta is not null then 'Distribuidor'
      else 'Sin dato'
    end as canal,
    case when b.lucera_raw ~* '^(no|sin)' then 'No'
         when upper(b.lucera_raw) in ('SI', 'SÍ') then 'Sí'
         else regexp_replace(b.lucera_raw, '\s*\(sin vidrio\)', '', 'i') end as lucera,
    case when b.puerta_raw ~* '^(no|sin)' then 'No'
         when b.puerta_raw ~* 'der' then 'Sí - Derecha'
         when b.puerta_raw ~* 'izq' then 'Sí - Izquierda'
         when b.puerta_raw ~* 'medio' then 'Sí - En medio'
         else b.puerta_raw end as puerta,
    case
      when b.despacho = 'Finalizado' then 'Despachado'
      when b.en_tablero then 'En producción'
      when b.fulfillment_mode = 'acopio' then 'En acopio (sin fabricar)'
      -- El tablero de planta arrancó en marzo 2026 solo con las NV activas: las
      -- del sistema anterior que no están ahí ya se fabricaron antes.
      when b.origen_dato = 'Sistema anterior' and coalesce(b.fecha_nv, date '2000-01-01') < date '2026-03-01'
        then 'Histórico (fabricado antes del tablero)'
      else 'Sin pasar a planta'
    end as estado,
    -- Nombre normalizado: "Daniel Preto (portón izquierda)" y "Daniel Preto (portón
    -- derecha)" son el mismo cliente con 2 portones, no 2 clientes distintos.
    nullif(trim(regexp_replace(lower(b.cliente), '\(.*?\)|[0-9]+|[^a-záéíóúñü ]', '', 'g')), '') as cliente_norm,
    -- Solo direcciones con altura: las que son solo una localidad ("VILLA MARIA")
    -- se repiten por ser imprecisas, no por ser del distribuidor.
    case when b.direccion ~ '\d'
         then trim(regexp_replace(lower(b.direccion), '[^a-z0-9áéíóúñü]+', ' ', 'g')) end as direccion_norm
  from base b
),
-- Alerta: el mismo link, o la misma calle+altura, aparece para clientes DISTINTOS
-- -> casi siempre es la dirección del distribuidor o de un transporte, no la de
-- instalación. Se mira cada uno por separado: un distribuidor puede cargar su
-- propia dirección con un link distinto en cada NV.
links_compartidos as (
  select maps_url_cargado as clave
  from final
  where maps_url_cargado is not null and cliente_norm is not null
  group by 1
  having count(distinct cliente_norm) > 1
),
direcciones_compartidas as (
  select direccion_norm as clave
  from final
  where direccion_norm is not null and cliente_norm is not null
  group by 1
  having count(distinct cliente_norm) > 1
),
marcadas as (
  select f.*,
    coalesce(f.maps_url_cargado in (select clave from links_compartidos)
      or f.direccion_norm in (select clave from direcciones_compartidas), false) as direccion_compartida,
    -- El link de Maps apunta al local del distribuidor (".../place/Aberturas+Pampeanas/...").
    coalesce(f.canal = 'Distribuidor' and f.maps_url_cargado ~* '/place/'
       and position(nullif(lower(split_part(regexp_replace(coalesce(f.distribuidor_nombre, f.razsoc_cuenta, ''), '^(ABERTURAS|ALUMINIOS|METALURGICA|METALÚRGICA)\s+', '', 'i'), ' ', 1)), '')
                    in lower(replace(f.maps_url_cargado, '+', ' '))) > 0, false) as maps_del_distribuidor
  from final f
)
select
  f.nv,
  to_char(f.fecha_nv, 'YYYY-MM-DD') as fecha_nv,
  f.estado,
  f.canal,
  case when f.canal = 'Distribuidor' then coalesce(f.distribuidor_nombre, f.razsoc_cuenta) end as distribuidor,
  f.id_cuenta,
  f.cliente,
  f.direccion,
  f.maps_url_cargado as maps_url,
  case
    when f.direccion is null and f.maps_url_cargado is null then 'Sin dirección'
    when f.maps_del_distribuidor then 'Revisar: link al local del distribuidor'
    when f.direccion_compartida then 'Revisar: misma dirección o link para varios clientes'
    when f.maps_url_cargado is not null then 'Link de Maps cargado'
    when f.direccion ~ '\d' then 'Dirección con altura (sin link)'
    else 'Solo localidad'
  end as calidad_direccion,
  -- Portón de stock del distribuidor (todavía no tiene cliente final).
  coalesce(f.cliente ~* '\mSTOCK\M', false) as es_stock,
  f.sistema,
  f.sistema_variante,
  f.color_sistema,
  f.color_revestimiento,
  f.tipo_revestimiento,
  f.orientacion_revestimiento,
  f.lucera,
  f.puerta,
  f.origen_dato,
  f.geo_lat,
  f.geo_lng
from marcadas f
-- Más nuevas primero: las NV viejas son las que tienen más datos vacíos.
order by f.nv desc;
`;

// En links ".../place/...", el "@lat,lng" que toma primero extractCoordsFromMapsUrl
// es el centro de la vista del mapa (con zoom bajo puede quedar a decenas de km);
// el punto exacto del lugar viene en "!3d<lat>!4d<lng>", así que va primero.
const PLACE_COORDS = /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/i;

function coordsDelLink(url) {
  const m = String(url || '').match(PLACE_COORDS);
  if (m) {
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return extractCoordsFromMapsUrl(url);
}

// El link cargado si existe; si no, una búsqueda de Google Maps con el texto de
// la dirección (puede no ser exacta: la columna calidad_direccion lo aclara).
function linkGoogleMaps(row) {
  if (row.maps_url) return row.maps_url;
  if (row.direccion) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(row.direccion)}`;
  return null;
}

async function listPortonesInstalados() {
  const { rows } = await pool.query(PORTONES_INSTALADOS_SQL);
  return rows.map(({ geo_lat, geo_lng, ...row }) => {
    const coords = coordsDelLink(row.maps_url)
      || (geo_lat != null && geo_lng != null ? { lat: Number(geo_lat), lng: Number(geo_lng) } : null);
    return {
      ...row,
      maps_link: linkGoogleMaps(row),
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null,
    };
  });
}

module.exports = { listPortonesInstalados };
