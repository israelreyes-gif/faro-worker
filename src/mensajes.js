import { json, error, cicloActual, usuarioDesdePeticion, comprobarRateLimit } from './utils.js';
import { enviarATodos } from './push.js';

const CATEGORIAS_VALIDAS = ['historia', 'recuerdo', 'consejo'];
const TEXTO_MAX_LENGTH = 500;
const MENSAJE_COOLDOWN_MS = 3000;

export async function postMensaje(request, env, origin) {
  const usuario = await usuarioDesdePeticion(request, env);
  if (!usuario) return error('No autenticado.', 401, origin);

  const { limitado, segundosRestantes } = await comprobarRateLimit(env, `mensaje_${usuario.id}`, MENSAJE_COOLDOWN_MS);
  if (limitado) {
    return error(`Espera ${segundosRestantes} segundo(s) antes de intentarlo de nuevo.`, 429, origin);
  }

  const { categoria, texto } = await request.json().catch(() => ({}));
  if (!CATEGORIAS_VALIDAS.includes(categoria)) {
    return error('Categoría no válida.', 400, origin);
  }
  if (!texto || !texto.trim()) {
    return error('Escribe algo antes de encender el faro.', 400, origin);
  }
  if (texto.trim().length > TEXTO_MAX_LENGTH) {
    return error(`El mensaje no puede superar los ${TEXTO_MAX_LENGTH} caracteres.`, 400, origin);
  }

  const ciclo = cicloActual();
  const sorteo = await env.DB
    .prepare('SELECT * FROM sorteos WHERE fecha_ciclo = ?').bind(ciclo).first();

  if (!sorteo) return error('Esta noche el faro aún no ha elegido a nadie.', 400, origin);
  if (sorteo.ganador_user_id !== usuario.id) {
    return error('Esta noche el faro no te ha iluminado a ti.', 403, origin);
  }

  const yaEscrito = await env.DB
    .prepare('SELECT id FROM mensajes WHERE sorteo_id = ?').bind(sorteo.id).first();
  if (yaEscrito) return error('Ya has dejado tu mensaje esta noche.', 409, origin);

  await env.DB.prepare(
    `INSERT INTO mensajes (sorteo_id, user_id, categoria, texto) VALUES (?, ?, ?, ?)`
  ).bind(sorteo.id, usuario.id, categoria, texto.trim()).run();

  await enviarATodos(env, {
    title: 'FARO',
    body: 'El faro ha hablado esta noche. Ven a leerlo.'
  });

  return json({ ok: true }, { status: 201 }, origin);
}
