export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

export function json(data, init = {}, origin) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
      ...(init.headers || {})
    }
  });
}

export function error(message, status = 400, origin) {
  return json({ error: message }, { status }, origin);
}

export function madridNow() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour, minute: +parts.minute, second: +parts.second,
    minutesOfDay: (+parts.hour) * 60 + (+parts.minute)
  };
}

export function cicloActual() {
  const now = madridNow();
  const RESET = 10 * 60;
  const d = new Date(Date.UTC(now.year, now.month - 1, now.day));
  if (now.minutesOfDay < RESET) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex
    ? hexToBytes(saltHex)
    : crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

export async function verifyPassword(password, hashHex, saltHex) {
  const { hash } = await hashPassword(password, saltHex);
  return hash === hashHex;
}

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

export async function firmarToken(payload, secret) {
  const body = btoa(JSON.stringify(payload));
  const sig = await hmac(body, secret);
  return `${body}.${sig}`;
}

export async function verificarToken(token, secret) {
  const [body, sig] = (token || '').split('.');
  if (!body || !sig) return null;
  const esperado = await hmac(body, secret);
  if (esperado !== sig) return null;
  const payload = JSON.parse(atob(body));
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

async function hmac(text, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return bytesToHex(new Uint8Array(sig));
}

export async function usuarioDesdePeticion(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const payload = await verificarToken(token, env.JWT_SECRET);
  return payload;
}

// Comprueba si ha pasado suficiente tiempo desde el último intento bajo esa
// clave. Si es así, registra el intento actual y devuelve { limitado: false }.
// Si no, devuelve { limitado: true, segundosRestantes } sin registrar nada nuevo.
export async function comprobarRateLimit(env, clave, minIntervaloMs) {
  const row = await env.DB
    .prepare('SELECT last_at FROM rate_limits WHERE clave = ?')
    .bind(clave).first();

  const ahora = Date.now();

  if (row) {
    const transcurrido = ahora - new Date(row.last_at).getTime();
    if (transcurrido < minIntervaloMs) {
      return { limitado: true, segundosRestantes: Math.ceil((minIntervaloMs - transcurrido) / 1000) };
    }
  }

  const iso = new Date(ahora).toISOString();
  await env.DB.prepare(
    `INSERT INTO rate_limits (clave, last_at) VALUES (?, ?)
     ON CONFLICT(clave) DO UPDATE SET last_at = ?`
  ).bind(clave, iso, iso).run();

  return { limitado: false };
}
