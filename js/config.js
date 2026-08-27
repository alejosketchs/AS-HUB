// AS SUITE — configuración
export const SUPABASE_URL = 'https://derzetuipyugmrjaxcyu.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_XC5v-_UBfrsnbTLIJPqe6w_xXz3tCA6';

export const TZ = 'America/Bogota';
export const CURRENCY = 'COP';

export const APP_VERSION = '3.3.2';
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

/* Citas reales, verificables: cada una con su fuente exacta (obra, capítulo o
   discurso). Antes eran frases inventadas atribuidas a "AS Oracle" con
   source:null, por eso la fuente nunca aparecía. */
export const FRASES = [
  { quote: 'No es que tengamos poco tiempo, sino que perdemos mucho.', author: 'Séneca', source: 'Sobre la brevedad de la vida (De Brevitate Vitae), cap. I' },
  { quote: 'Muy poco es necesario para vivir feliz: todo está en tu manera de pensar.', author: 'Marco Aurelio', source: 'Meditaciones, Libro VII, 67' },
  { quote: 'Recuerda que el tiempo es dinero.', author: 'Benjamin Franklin', source: 'Consejos a un joven comerciante, 1748' },
  { quote: 'Estudiar sin pensar es esfuerzo perdido; pensar sin estudiar es peligroso.', author: 'Confucio', source: 'Analectas, Libro II, 15' },
  { quote: 'El trabajo se expande hasta llenar el tiempo disponible para completarlo.', author: 'C. Northcote Parkinson', source: '"Parkinson\'s Law", The Economist, 1955' },
  { quote: 'Un viaje de mil millas comienza con un solo paso.', author: 'Lao Tsé', source: 'Tao Te Ching, capítulo 64' },
  { quote: 'Si uno avanza con confianza en la dirección de sus sueños y se esfuerza por vivir la vida que ha imaginado, se encontrará con un éxito inesperado.', author: 'Henry David Thoreau', source: 'Walden, "Conclusión", 1854' },
  { quote: 'La perfección se alcanza no cuando ya no hay nada que añadir, sino cuando ya no hay nada que quitar.', author: 'Antoine de Saint-Exupéry', source: 'Tierra de hombres, 1939' },
  { quote: 'Vuestro tiempo es limitado, así que no lo desperdiciéis viviendo la vida de otro.', author: 'Steve Jobs', source: 'Discurso de graduación en Stanford, 12 de junio de 2005' },
  { quote: 'Todo tiene su tiempo, y todo lo que se quiere debajo del cielo tiene su hora.', author: 'Eclesiastés 3:1', source: 'Biblia' },
  { quote: 'No es pobre el que tiene poco, sino el que codicia más.', author: 'Séneca', source: 'Cartas a Lucilio (Epistulae morales ad Lucilium), Carta II' },
];
