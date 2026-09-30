// lib/qcTokenInterno.js
//
// Token secreto que vive solo en memoria de este proceso (se regenera en
// cada arranque) para que el propio backend pueda llamar a /qc/authorize
// identificando al usuario por id en vez de por PIN - lo usa /despacho-v2
// al marcar un despacho entregado: el integrante de la cuadrilla ya entró
// con su PIN al loguearse, no se lo vuelve a pedir (pedido explícito del
// usuario, 2026-09-29). Desde afuera no se puede usar: sin este token,
// /qc/authorize sigue exigiendo PIN como siempre.
const crypto = require('crypto');

const QC_TOKEN_INTERNO = crypto.randomBytes(32).toString('hex');

function esTokenInterno(valor) {
  const a = Buffer.from(String(valor || ''));
  const b = Buffer.from(QC_TOKEN_INTERNO);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { QC_TOKEN_INTERNO, esTokenInterno };
