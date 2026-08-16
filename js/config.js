// AS SUITE — configuración
export const SUPABASE_URL = 'https://derzetuipyugmrjaxcyu.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_XC5v-_UBfrsnbTLIJPqe6w_xXz3tCA6';

export const TZ = 'America/Bogota';
export const CURRENCY = 'COP';

export const APP_VERSION = '3.3.1';
/* Respaldo por si el servidor no informa la fecha del archivo.
   La fecha real se lee del encabezado Last-Modified (ver ui.js → buildDate). */
export const BUILD_DATE = '2026-08-16';

/* Sesión compartida por todo el Suite */
export const SESSION_KEY = 'assuite:token';
export const SESSION_DAYS = 30;
export const PIN_SALT = 'as-suite';

/* Acentos disponibles para personalizar Finanzas.
   Paleta curada: todos conservan el contraste del sistema neo-brutalista. */
export const ACCENTS = {
  lima: { label: 'Lima', base: '#c7f24a', deep: '#b3e82f', soft: '#eef9d6', on: '#101010' },
  rosa: { label: 'Rosa', base: '#ff8ec8', deep: '#ff4fab', soft: '#fde7f3', on: '#101010' },
  azul: { label: 'Azul', base: '#8ec2ff', deep: '#4a7fe0', soft: '#e4edfc', on: '#101010' },
  lila: { label: 'Lila', base: '#c3aeff', deep: '#7b5fe0', soft: '#ece5ff', on: '#101010' },
  mango: { label: 'Mango', base: '#ffc46b', deep: '#f59e0b', soft: '#fdf1e3', on: '#101010' },
  menta: { label: 'Menta', base: '#7fe6c4', deep: '#16b184', soft: '#dff7ee', on: '#101010' },
};

/* Sitios del ecosistema que no son una de las apps principales.
   El enlace de cada uno se guarda en Supabase (suite_data, fila 'links')
   y se edita desde el propio Hub, así no hay que tocar código para cambiarlo. */
export const SITIOS_EXTRA = [
  { key: 'arpegios', nombre: 'Arpegios', descripcion: 'Cuaderno de acordes y progresiones.', emoji: '🎸', accent: 'var(--purple)' },
];

export const FRASES = [
  { quote: 'La prisa hace ruido; el rumbo hace progreso.', author: 'AS Oracle', source: null },
  { quote: 'Hecho es mejor que perfecto, pero no mejor que pensado.', author: 'AS Oracle', source: null },
  { quote: 'Lo que no se mide, se inventa.', author: 'AS Oracle', source: null },
  { quote: 'Un día ordenado vale por tres improvisados.', author: 'AS Oracle', source: null },
  { quote: 'El dinero se va por donde nadie está mirando.', author: 'AS Oracle', source: null },
  { quote: 'Empieza pequeño, pero empieza hoy.', author: 'AS Oracle', source: null },
  { quote: 'La constancia le gana al talento cuando el talento no aparece.', author: 'AS Oracle', source: null },
  { quote: 'No hay atajos hacia donde vale la pena llegar.', author: 'AS Oracle', source: null },
  { quote: 'Tu yo de mañana agradece lo que hiciste hoy.', author: 'AS Oracle', source: null },
  { quote: 'Cierra ciclos: lo abierto pesa más que lo difícil.', author: 'AS Oracle', source: null },
  { quote: 'Gastar menos también es ganar más.', author: 'AS Oracle', source: null },
  { quote: 'La claridad es una decisión, no una casualidad.', author: 'AS Oracle', source: null },
  { quote: 'Menos ruido. Más vida.', author: 'AS Oracle', source: null },
  { quote: 'Lo urgente grita; lo importante susurra.', author: 'AS Oracle', source: null },
];
