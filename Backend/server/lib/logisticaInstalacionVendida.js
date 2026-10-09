// lib/logisticaInstalacionVendida.js
//
// Logística decide "con instalación" por fecha_llegada_imput (la "Fecha
// Llegada/Instalación" de /a): un NV que vendió instalación pero al que nadie
// le cargó esa fecha aparecía solo como despacho (caso NV 4413, "Bonificado:
// Servicio de Instalacion"). Pedido del usuario: cuando se le asigna la fecha
// de despacho, la instalación toma esa misma fecha y el NV queda desglosado en
// despacho + instalación para repartirlos en rutas. En la práctica caen juntas:
// 111 de 115 NV recientes con las dos fechas tienen la instalación la misma
// semana que la salida (81 el mismo día).
//
// Se aplica al grabar fecha_salida_imput (PUT /preproduccion-valores/:id, que
// usan /a y Planificación de Fechas, y la asignación desde el mapa):
//   - vendió instalación (la opción del Presupuestador dice "...Servicio de
//     Instalacion" y no empieza con "Sin"), y
//   - fecha_llegada_imput está vacía, o es igual a la salida anterior y
//     todavía no pasó (venía acompañando al despacho: si se mueve el despacho,
//     se mueve con él).
// Una fecha de instalación distinta cargada a mano, o una ya pasada (la que
// graba /despacho_v2 como cierre real de la instalación), no se toca.

/**
 * Expresión SQL (jsonb) a concatenar con `||` al data actualizado.
 * @param {string} dataCol - columna/alias del data ANTERIOR (ej. 'data', 'pv.data')
 * @param {string} nuevaSalidaExpr - expresión SQL text con la nueva fecha (ej. '$3::text')
 */
function sqlInstalacionSigueSalida(dataCol, nuevaSalidaExpr) {
  const opcion = `coalesce(${dataCol}->>'section__servicio_de_instalacion_de_grandis_portones', ${dataCol}->>'section__instalacion', '')`;
  return `(case
    when nullif(${nuevaSalidaExpr}, '') is not null
     and ${opcion} ~* 'servicio de instalaci'
     and ${opcion} !~* '^\\s*sin'
     and (
       nullif(${dataCol}->>'fecha_llegada_imput', '') is null
       or (${dataCol}->>'fecha_llegada_imput' = ${dataCol}->>'fecha_salida_imput'
           and nullif(${dataCol}->>'fecha_salida_imput', '')::date >= current_date)
     )
    then jsonb_build_object('fecha_llegada_imput', ${nuevaSalidaExpr})
    else '{}'::jsonb
  end)`;
}

module.exports = { sqlInstalacionSigueSalida };
