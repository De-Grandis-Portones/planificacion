// src/utils/planilla4000.js
//
// Arma la planilla "+4000" (hoja PRINCIPAL del LISTADO DE PORTONES) a partir
// de los datos que ya tiene Planta, para que /diseno_v2 se la pase a la
// herramienta de diseño (portones_v6.html) sin que nadie tenga que cargarla a
// mano.
//
// Cada portón puede venir de dos lados:
//   - Presupuestador (NV nuevas): Ancho/Alto/Sistema + `dimensions` (cálculo
//     de piernas, parantes, hoja) + las opciones cotizadas (`section__*`).
//     Las columnas técnicas (perfil del caño, pierna, motor doble, etc.) se
//     deducen con reglas sacadas de comparar ~210 portones contra la +4000
//     real que carga la oficina técnica.
//   - Sistema anterior (NV viejas, `preproduccion_sql`): ya traen las columnas
//     técnicas con su propio nombre (PIERNAS_Altura, DINTEL_Ancho, ...).
//
// Las columnas calculadas por fórmula en la planilla real (AB, AC, AJ, AO,
// AR-AT, AV-AX, AZ) se calculan acá con la misma fórmula.

export const COLUMNAS = 53; // A..BA, que es hasta donde lee el HTML

const LETRAS = (() => {
  const out = [];
  for (let i = 0; i < 80; i++) {
    let n = i + 1;
    let s = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    out.push(s);
  }
  return out;
})();

export function indiceDeColumna(letra) {
  return LETRAS.indexOf(String(letra || '').toUpperCase());
}

// Perfil del caño de la hoja: la planilla carga un código en AI y la
// descripción (AJ) sale de esta tabla (misma fórmula que la columna AJ).
export const PERFILES_CANO = {
  1: '30X50X1,2',
  2: '40X50X1,2',
  3: '50X50X1,2',
  4: '50X70X1,2',
  5: '70X70X1,6',
  6: '80x80',
  7: '40x80x1,6',
};

const up = (v) => String(v ?? '').trim().toUpperCase();
const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');

function numero(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Mismo criterio que el resto de Planta (toMmHeuristic en el backend, que es
// el que usa el workflow para rutear Laser Dintel / Corte Dintel): hay filas
// en metros (6.14) y filas en mm (6140).
function aMm(v) {
  const n = numero(v);
  if (n == null || n <= 0) return null;
  return n < 50 ? Math.round(n * 1000) : Math.round(n);
}

// Un portón de menos de 1 m de ancho o alto es casi seguro un dato mal
// cargado (ej. 249 por 2490). Las puertas sí pueden ser angostas.
function medidaSospechosa(p, mm) {
  return mm != null && mm < 1000 && p?.tipo !== 'puerta' && up(p?.Tipo) !== 'PUERTA';
}

function esLegacy(p) {
  return !p?.dimensions && (p?.PIERNAS_Altura != null || p?.DINTEL_Ancho != null || p?.PIERNAS_Tipo != null);
}

function familia(sistema) {
  const s = up(sistema);
  if (s.includes('COPLANAR')) return 'COPLANAR';
  if (s.includes('PARA REVESTIR')) return 'REVESTIR';
  if (s.includes('DOBLE')) return 'ACERO_INY';
  return 'ACERO';
}

// En el Presupuestador un "para revestir" puede ser igual coplanar: viene en
// la opción "Sistema de portón Coplanar" y la planilla lo trata como coplanar
// (pierna, caño, espesor), con el revestimiento puesto por otro.
function familiaDe(p) {
  if (up(p.section__tipo_de_sistema_de_porton).includes('COPLANAR')) return 'COPLANAR';
  return familia(p.Sistema);
}

function esParaRevestir(p) {
  return up(p.Sistema).includes('PARA REVESTIR');
}

// La oficina técnica carga las medidas de a 10 mm (5766 -> 5760).
const piso10 = (v) => (v == null ? null : Math.floor(v / 10) * 10);

// ---------------------------------------------------------------------------
// Traducciones de las opciones del Presupuestador a como se escriben en la
// planilla.
// ---------------------------------------------------------------------------

// "Sistema color Negro Semimate" -> "NEGRO SATINADO", etc.
function colorPlanilla(texto) {
  const t = sinAcentos(up(texto))
    .replace(/^(SISTEMA|REVEST)\s+(COLOR\s+)?/, '')
    .replace(/COLOR DEL REVESTIMIENTO/, '')
    .replace(/^MADERA\s+/, '')
    .trim();
  if (!t) return '';
  if (/NEGRO SEMIMATE|NEGRO SATINADO/.test(t)) return 'NEGRO SATINADO';
  if (/NEGRO TEXT(URADO)? MATE|NEGRO MICRO/.test(t)) return 'NEGRO MICRO';
  if (/NEGRO TEXT(URADO)? BRILLANTE/.test(t)) return 'NEGRO TEXT';
  if (/BRONCE/.test(t)) return 'BRONCE';
  if (/GRIS TOPO/.test(t)) return 'GRIS TOPO';
  if (/GRIS GRAFITO/.test(t)) return 'GRIS GRAFITO';
  if (/GRIS MELANGE/.test(t)) return 'GRIS MELANGE';
  if (/ROBLE DORADO/.test(t)) return 'ROBLE DORADO';
  if (/ROBLE CLARO|TURNER/.test(t)) return 'ROBLE TURNER';
  if (/NOGAL/.test(t)) return 'NOGAL';
  if (/CORTEN/.test(t)) return 'CORTEN';
  if (/BLANCO/.test(t)) return 'BLANCO';
  return t;
}

// "Listón Acero inoxidable (Gris) (15mm entre Lamas)" -> "CROMO", etc.
function listonPlanilla(texto) {
  const t = sinAcentos(up(texto));
  if (!t) return 'NO';
  if (/INOXIDABLE|CROMO/.test(t)) return 'CROMO';
  if (/NOGAL/.test(t)) return 'NOGAL';
  if (/ROBLE|TURNER/.test(t)) return 'ROBLE';
  if (/BLANCO/.test(t)) return 'BLANCO';
  if (/NEGRO/.test(t)) return 'NEGRO';
  if (/GRIS/.test(t)) return 'GRIS';
  if (/BRONCE/.test(t)) return 'BRONCE';
  if (/CORTEN/.test(t)) return 'CORTEN';
  if (/^SIN|^NO\b/.test(t)) return 'NO';
  return t;
}

// Tipo de pierna. Parte del cálculo del Presupuestador, pero cuando ese da
// "comunes" la oficina técnica decide por sistema y ancho (sacado de la +4000
// real): el acero propio adentro del vano va con pierna angosta hasta 3,5 m,
// el inyectado hasta ~2,7 m, y los para revestir pasan a ancha desde ~3,9 m.
// Superanchas/Especiales se cargan como ANCHA.
function piernaPlanilla(p, fam, ancho, posicion) {
  const calc = up(p?.dimensions?.porton_piernas_calculo || p?.dimensions?.calculated_legs_label);
  if (calc.startsWith('ANGOSTA')) return 'ANGOSTA';
  if (calc.startsWith('ANCHA') || calc.startsWith('SUPERANCHA') || calc.startsWith('ESPECIAL')) return 'ANCHA';
  if (!calc.startsWith('COMUN') || !ancho) return '';
  if (fam === 'ACERO') return posicion === 'ADENTRO' && ancho < 3500 ? 'ANGOSTA' : 'COMUN';
  if (fam === 'ACERO_INY') return ancho < 2700 ? 'ANGOSTA' : 'COMUN';
  if (fam === 'REVESTIR') return ancho >= 3900 ? 'ANCHA' : 'COMUN';
  return ancho >= 4800 ? 'ANCHA' : 'COMUN';
}

// Perfil del caño de la hoja (código de AI) según familia y ancho. Umbrales
// sacados de la +4000 real; son los casos típicos, la oficina técnica a veces
// sube un perfil por peso o por revestimientos especiales.
function perfilCano(fam, ancho, alturaPierna) {
  if (!ancho) return null;
  if (fam === 'COPLANAR') return ancho >= 5000 ? 6 : 7;
  if (fam === 'REVESTIR') {
    if (ancho >= 5000) return 5;
    if (ancho >= 3900) return 3;
    return 2;
  }
  if (fam === 'ACERO_INY') {
    if (ancho >= 4500) return 5;
    if (ancho >= 2750) return 2;
    return 1;
  }
  if (ancho >= 4500) return 5;
  if (ancho >= 4000) return 3;
  if (ancho > 3000 || alturaPierna >= 2500) return 2;
  return 1;
}

function ladoMotor(p) {
  const t = up(p.section__lado_del_motor_tomacorrientes || p.section__lado_del_motor || p.section__lado_del_soporte_para_motor || p.section__lado_del_soporte);
  if (t.includes('IZQ')) return 'IZQUIERDA';
  if (t.includes('DER')) return 'DERECHA';
  return '';
}

function planchuelaMm(p) {
  const t = up(p.section__planchuela_de_rebaje_inferior_y_lateral || p.section__rebaje);
  if (!t) return null;
  if (/^SIN/.test(t)) return 0;
  const m = t.match(/(\d{2})\s*MM/);
  return m ? Number(m[1]) : null;
}

// Columna L (texto libre que lee el HTML para revestimiento, puerta, luceras,
// parantes...). Se arma con las mismas frases que usa la oficina técnica.
function armarDescripcion(p, f) {
  const fam = familiaDe(p);
  const partes = [];
  const orientRev = up(p.section__orientacion_del_revestimiento_en_lamas);
  const vertical = orientRev.includes('VERTICAL');

  if (esParaRevestir(p)) {
    if (fam === 'COPLANAR') partes.push('COPLANAR');
    const r = up(p.section__tipo_de_revestimiento_a_colocar);
    if (r.includes('ALUMINIO')) partes.push('ALUMINIO');
    else if (r.includes('WPC')) partes.push('WPC');
    else if (r.includes('MADERA')) partes.push('MADERA');
    else if (r.includes('PVC')) partes.push('PVC');
    else if (r && fam !== 'COPLANAR') partes.push(sinAcentos(r));
    if (/PVC (REHAU|MUCHTEK)|LAMAS DE PVC/.test(r)) partes.push('PONER G DE REVESTIMIENTO');
  } else if (fam === 'COPLANAR') {
    partes.push('COPLANAR');
    let t = 'VARILLADO 20X10X20';
    if (up(p.Sistema).includes('DOBLE')) t += ' INYECTADO';
    if (f.N) t += ' ' + f.N;
    partes.push(t);
  } else {
    let t = 'SIMIL ' + (f.N || '');
    if (fam === 'ACERO_INY') t += ' INYECTADO';
    if (vertical) t += ' VERTICAL';
    partes.push(t.trim());
  }

  const luc = up(p.section__lucera_para_vidrio);
  if (luc.startsWith('DOS')) partes.push('DOS LUCERAS');
  else if (luc.startsWith('TRES')) partes.push('TRES LUCERAS');
  else if (luc.startsWith('CUATRO')) partes.push('CUATRO LUCERAS');

  const div = up(p.section__division_frontal_del_revestimiento_en_lamas);
  const mDiv = div.match(/DIVIDIDO EN (\d)/);
  if (mDiv && mDiv[1] === '2') partes.push('PAÑO FIJO DIVIDIDO EN DOS');

  if (up(p.section__puerta_de_paso_peatonal).includes('MEDIO')) partes.push('PUERTA AL MEDIO');

  if ((fam === 'ACERO' || fam === 'ACERO_INY') && f.AV !== 'SI') partes.push('PLANCHUELA PARA CUBRIR REV');

  if (up(p.dimensions?.orientacion_parantes || p.orientacion_parantes).startsWith('HORIZONTAL')) {
    partes.push('PARANTE HORIZONTAL 50X50');
  }

  if (f.Z === 'DOBLE') {
    const lado = ladoMotor(p);
    if (lado) partes.push('CABLE MOTOR A LA ' + (lado === 'IZQUIERDA' ? 'IZQ' : 'DER'));
  }

  return partes.join('-');
}

// ---------------------------------------------------------------------------
// Fórmulas de la planilla (mismas columnas calculadas que el Excel)
// ---------------------------------------------------------------------------
function aplicarFormulas(f) {
  f.AB = f.Y === '' ? '' : (f.Y === 'AUTOMATICO' ? 'NO' : 'SI');
  f.AC = f.U === '' ? '' : (f.U === 'SI' && f.W === 'SE HACE ACA' ? 'SI' : 'NO');
  f.AJ = f.AI != null ? (PERFILES_CANO[f.AI] || '') : (f.AJ || '');
  f.AO = f.AO || (f.AG === '' ? '' : '60X100');

  const am = numero(f.AM);
  const an = numero(f.AN) ?? 40;
  if (am) {
    const bs = ((am - 20) / 2) - an;
    const bt = (bs * (bs + (2 * (110 + an)))) / (2 * (bs + 110 + an));
    const ar = bs + (110 + an) - bt;
    f.AR = ar;
    f.AS = ar - 95;
    f.AT = ar - 95 + bt;
  }

  const ba = numero(f.BA);
  f.AZ = ba > 0 ? 'SI' : 'NO';
  f.AV = f.AZ;
  f.AW = f.AV === 'SI' ? 5 : '';
  if (am) f.AX = f.AV === 'SI' ? am - 5 : am;
}

// ---------------------------------------------------------------------------
// Un portón -> su fila
// ---------------------------------------------------------------------------

// "ABERTURAS ALFA SRL" -> "ABERTURAS ALFA" (la planilla no lleva la razón
// social completa).
function sinSociedad(nombre) {
  return up(nombre).replace(/[\s,]+(S\.?\s?R\.?\s?L\.?|S\.?\s?A\.?|S\.?\s?A\.?\s?S\.?)$/, '').trim();
}

// La planilla escribe el cliente "APELLIDO NOMBRE". En el Presupuestador el
// nombre a veces ya trae el apellido al final ("Enrique Maiza").
function clientePlanilla(p) {
  const apellido = up(p.cliente_apellido);
  let nombre = up(p.cliente_nombre);
  if (apellido && nombre.endsWith(' ' + apellido)) nombre = nombre.slice(0, -apellido.length).trim();
  return [apellido, nombre].filter(Boolean).join(' ') || up(p.Nombre);
}

function desdePresupuestador(p, avisos) {
  const f = {};
  const fam = familiaDe(p);
  const paraRevestir = esParaRevestir(p);
  const ancho = piso10(aMm(p.Ancho));
  const alto = aMm(p.Alto);
  const distribuidor = sinSociedad(p.distribuidor_nombre || p.RazSoc);
  const esDeDistribuidor = !p.vendido_por_rol || up(p.vendido_por_rol) === 'DISTRIBUIDOR';

  f.B = clientePlanilla(p);
  f.C = up(p.cliente_localidad);
  f.D = esDeDistribuidor && distribuidor ? distribuidor : 'DE GRANDIS PORTONES';
  f.K = paraRevestir ? (f.D !== 'DE GRANDIS PORTONES' ? f.D : 'CLIENTE') : 'DE GRANDIS PORTONES';

  const luc = up(p.section__lucera_para_vidrio);
  f.M = luc && !luc.startsWith('SIN') ? 'SI' : 'NO';

  if (paraRevestir) {
    f.N = 'SISTEMA';
  } else {
    const c = p.section__color_del_revestimiento_simil_aluminio
      || p.section__color_del_revestimiento_simil_madera_otros
      || p.section__color_del_revestimiento
      || p.section__color_madera
      || p.Color;
    f.N = colorPlanilla(c);
    if (!f.N) avisos.push('N: falta el color del revestimiento');
  }
  f.O = listonPlanilla(p.section__insertos_listones_apliques_15mm_entre_lamas || p.section__insertos_horizontales_listones || p.Liston);

  const parantes = numero(p.dimensions?.cantidad_parantes ?? p.cantidad_parantes);
  f.R = parantes ?? '';
  if (parantes == null) avisos.push('R: falta la cantidad de parantes');
  const orient = up(p.dimensions?.orientacion_parantes || p.orientacion_parantes);
  const distrib = up(p.dimensions?.distribucion_parantes || p.distribucion_parantes);
  f.S = orient.startsWith('VERTICAL') && distrib.startsWith('REPARTIDO') ? 'REPARTIDO' : 'SEGÚN PLANO';

  f.T = colorPlanilla(p.section__color_del_sistema_estructura || p.section__color_de_sistema || p.Color_Sistema);
  if (!f.T) avisos.push('T: falta el color del sistema');

  const puerta = up(p.section__puerta_de_paso_peatonal);
  if (!puerta) avisos.push('U: no figura si lleva puerta peatonal (se asume que no)');
  f.U = puerta && !puerta.startsWith('SIN') ? 'SI' : 'NO';
  f.V = f.U === 'SI' ? (puerta.includes('IZQ') ? 'IZQUIERDA' : 'DERECHA') : '';
  f.W = f.U === 'SI' ? 'SE HACE ACA' : '';

  const acc = up(p.section__modo_de_accionamiento || p.section__automatizacion || p.section__tipo_de_accionamiento || p.MOTOR_Condicion);
  f.Y = acc.includes('MANUAL') ? 'MANUAL' : 'AUTOMATICO';

  f.AP = ancho ?? '';
  if (!ancho) avisos.push('AP: falta el ancho');
  if (medidaSospechosa(p, ancho)) avisos.push(`AP: el ancho cargado (${p.Ancho}) parece estar mal, revisar en /a`);
  if (medidaSospechosa(p, alto)) avisos.push(`AM: el alto cargado (${p.Alto}) parece estar mal, revisar en /a`);
  f.Z = ancho && ancho >= 3900 ? 'DOBLE' : (ladoMotor(p) || 'DERECHA');

  const inst = up(p.section__servicio_de_instalacion_de_grandis_portones || p.section__instalacion);
  if (/^SIN/.test(inst)) f.AE = 'TERCERO';
  else if (inst) f.AE = 'FABRICA';
  else { f.AE = ''; avisos.push('AE: no figura quién instala'); }

  const ancl = up(p.section__tipo_de_anclajes || p.section__tipo_de_anclajes_para_instalar || p.section__tipo_de_anclaje);
  f.AF = ancl.startsWith('CON') ? 'SI' : 'NO';

  const pos = up(p.section__posicion_respecto_al_vano || p.section__tipo_de_colocacion || p.dimensions?.porton_colocacion_label);
  f.AG = /DETR|ATR/.test(sinAcentos(pos)) ? 'ATRÁS' : 'ADENTRO';

  f.AM = alto ? piso10(alto - 100) : '';
  if (!alto) avisos.push('AM: falta el alto');
  f.AI = perfilCano(fam, ancho, f.AM || 0);
  f.AL = piernaPlanilla(p, fam, ancho, f.AG);
  if (!f.AL) avisos.push('AL: falta el tipo de pierna');
  const rev = up(p.section__tipo_de_revestimiento_a_colocar);
  f.AN = fam === 'COPLANAR' || rev.includes('WALL PANEL') ? 80 : 40;

  // Rebaje (planchuela lateral e inferior): la opción cotizada manda; si no
  // está, los para revestir y coplanares llevan 45 y el acero propio lleva 40
  // desde 3,5 m de ancho (más angosto va sin rebaje y con "planchuela para
  // cubrir rev" en la descripción).
  const pl = planchuelaMm(p);
  if (pl != null) f.BA = pl || '';
  else if (paraRevestir || fam === 'COPLANAR') f.BA = 45;
  else f.BA = ancho && ancho >= 3500 ? 40 : '';

  aplicarFormulas(f);
  f.L = armarDescripcion(p, f);
  return f;
}

// "70x70" (como lo guardaba el sistema anterior) -> código de AI.
function codigoPerfil(descripcion) {
  const t = up(descripcion).replace(/\s+/g, '');
  const m = t.match(/^(\d+)X(\d+)/);
  if (!m) return null;
  const clave = `${m[1]}X${m[2]}`;
  for (const [cod, desc] of Object.entries(PERFILES_CANO)) {
    if (up(desc).startsWith(clave)) return Number(cod);
  }
  return null;
}

function desdeSistemaAnterior(p, avisos) {
  const f = {};
  const fam = familia(p.Sistema);
  f.B = up(p.Nombre);
  f.C = up(p.Direccion);
  f.D = up(p.RazSoc).replace(/\s+\d+$/, '');
  f.K = up(p.Revestimiento);
  f.M = up(p.Lucera) === 'SI' ? 'SI' : 'NO';
  f.N = fam === 'REVESTIR' ? 'SISTEMA' : colorPlanilla(String(p.Color || '').replace(/\bOSC\b/i, ''));
  f.O = listonPlanilla(p.Liston);
  f.R = numero(p.PARANTES_Cantidad) ?? '';
  f.S = up(p.PARANTES_Distribucion) || 'REPARTIDO';
  f.T = colorPlanilla(p.Color_Sistema);
  const puertaAncho = numero(p.Puerta_Ancho);
  const posPuerta = up(p.PUERTA_Posicion);
  f.U = puertaAncho > 0 ? 'SI' : 'NO';
  f.V = f.U === 'SI' ? (posPuerta.includes('IZQ') ? 'IZQUIERDA' : 'DERECHA') : '';
  f.W = f.U === 'SI' ? 'SE HACE ACA' : '';
  f.Y = up(p.MOTOR_Condicion).includes('MANUAL') ? 'MANUAL' : 'AUTOMATICO';
  f.AP = numero(p.DINTEL_Ancho) || aMm(p.Ancho) || '';
  const lado = up(p.MOTOR_Posicion);
  f.Z = f.AP && f.AP >= 3900 ? 'DOBLE' : (lado.includes('IZQ') ? 'IZQUIERDA' : 'DERECHA');
  const inst = up(p.INSTALACION_Instalador);
  f.AE = inst.startsWith('FABRICA') ? 'FABRICA' : (inst ? 'TERCERO' : '');
  f.AF = up(p.INSTALACION_Empotraduras) === 'SI' ? 'SI' : 'NO';
  f.AG = /ATR/.test(sinAcentos(up(p.INSTALACION_Posicion))) ? 'ATRÁS' : 'ADENTRO';
  f.AI = codigoPerfil(p.PARANTES_Descripcion);
  f.AL = up(p.PIERNAS_Tipo);
  f.AM = numero(p.PIERNAS_Altura) ?? '';
  f.AN = numero(p.Espesor_Revestimiento) || 40;
  f.AO = up(p.DINTEL_Tipo);
  f.BA = numero(p.RBJ_Ancho) || '';
  if (!f.AM) avisos.push('AM: falta la altura de pierna');
  if (!f.AP) avisos.push('AP: falta el ancho');
  if (!f.AL) avisos.push('AL: falta el tipo de pierna');
  if (f.AI == null) avisos.push('AJ: no se reconoce el perfil del caño');
  aplicarFormulas(f);

  if (p.Descripcion) {
    f.L = up(p.Descripcion);
  } else {
    const partes = [];
    if (fam === 'REVESTIR') partes.push('ALUMINIO');
    else partes.push(('SIMIL ' + f.N + (fam === 'ACERO_INY' ? ' INYECTADO' : '')).trim());
    if (f.U === 'SI' && posPuerta.includes('MEDIO')) partes.push('PUERTA AL MEDIO');
    if ((fam === 'ACERO' || fam === 'ACERO_INY') && f.AV !== 'SI') partes.push('PLANCHUELA PARA CUBRIR REV');
    if (f.Z === 'DOBLE') partes.push('CABLE MOTOR A LA ' + (lado.includes('IZQ') ? 'IZQ' : 'DER'));
    f.L = partes.join('-');
    avisos.push('L: el sistema anterior no trae la descripción, se armó una básica');
  }
  return f;
}

/**
 * Fila de la +4000 para un portón de Planta (objeto tal como lo devuelve
 * GET /portones: columnas del portón + preproduccion_valores.data aplanado).
 * Devuelve { fila: Array(53), valores: {A: .., B: ..}, avisos: [], origen }.
 */
export function filaPlanilla4000(p) {
  const avisos = [];
  const legacy = esLegacy(p);
  const f = legacy ? desdeSistemaAnterior(p, avisos) : desdePresupuestador(p, avisos);
  if (!legacy && !p?.dimensions) avisos.push('Sin datos del Presupuestador: casi todo queda vacío');

  f.A = numero(p.nv) ?? p.nv;
  // La partida de la +4000 (565, 566...) la numera la oficina técnica y no
  // está en Planta (portones.partida vale 0/800); solo la traen las NV del
  // sistema anterior.
  f.P = p.PARTIDA ?? '';

  const fila = new Array(COLUMNAS).fill(null);
  for (const [letra, v] of Object.entries(f)) {
    const i = indiceDeColumna(letra);
    if (i >= 0 && i < COLUMNAS) fila[i] = v === '' || v === undefined ? null : v;
  }
  return { fila, valores: f, avisos, origen: legacy ? 'sistema anterior' : 'presupuestador' };
}

// Encabezados de la hoja PRINCIPAL real (fila 1: grupos, fila 2: columna),
// solo de las columnas que se completan acá.
export const GRUPOS = {
  K: 'REVESTIMIENTO', R: 'PARANTES', U: 'PUERTA', Y: 'MOTOR', AB: 'PASADOR', AC: 'PUERTA',
  AE: 'INSTALACION', AI: 'PARANTES', AL: 'PIERNAS', AO: 'DINTEL', AR: 'DATOS', AV: 'REBAJE',
  AZ: 'Rebaje lateral e inferior',
};
export const ENCABEZADOS = {
  A: 'Nota de Venta', B: 'CLIENTE +4000', C: 'DIRECCION CLIENTE', D: 'DISTRIBUIDOR',
  K: 'FABRICANTE', L: 'TIPO', M: 'LUCERA', N: 'COLOR DE SIMIL ALUMINIO', O: 'LISTON',
  P: 'PARTIDA', R: 'CANTIDAD', S: 'DISTRIBUCION', T: 'COLOR DE SISTEMA', U: 'CONDICION',
  V: 'POSICION', W: 'DESCRIPCION', Y: 'CONDICION.', Z: 'DOBLE', AB: 'CONDICION..',
  AC: 'ARMADO PUERTA', AE: 'INSTALADOR', AF: 'EMPOTRA DURAS', AG: 'POSICION.', AI: 'N° PIEZA',
  AJ: 'DESCRIPCION ', AL: 'TIPO.', AM: 'ALTURA', AN: 'ESPESOR REVEST', AO: 'TIPO…', AP: 'ANCHO',
  AR: 'BRAZOS', AS: 'HUECO CHICO', AT: 'HUECO GRANDE', AV: 'SI/NO', AW: 'DESCUENTO ',
  AX: 'ALTURA.', AZ: 'SI/NO2', BA: 'DESCUENTO 2',
};

/**
 * Matriz completa en el formato de la hoja PRINCIPAL: dos filas de
 * encabezado (la segunda con "Nota de Venta" en A, que es lo que busca el
 * HTML) y una fila por portón desde la tercera.
 */
export function matrizPlanilla4000(portones) {
  const grupos = new Array(COLUMNAS).fill(null);
  const encabezado = new Array(COLUMNAS).fill(null);
  for (const [letra, v] of Object.entries(GRUPOS)) grupos[indiceDeColumna(letra)] = v;
  for (const [letra, v] of Object.entries(ENCABEZADOS)) encabezado[indiceDeColumna(letra)] = v;
  const porPorton = (portones || []).map((p) => ({ porton: p, ...filaPlanilla4000(p) }));
  return {
    filas: [grupos, encabezado, ...porPorton.map((x) => x.fila)],
    porPorton,
  };
}
