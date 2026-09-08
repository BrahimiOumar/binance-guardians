const PUBLIC_API = "https://api.binance.com/api/v3";

async function fetchJson(path) {
  const response = await fetch(`${PUBLIC_API}${path}`);
  if (!response.ok) throw new Error(`Binance public API ${response.status} sur ${path}`);
  return response.json();
}

/**
 * NOTE IMPORTANTE (testé le 07/09) :
 * Le endpoint agent.binance.com/mcp/agentic renvoie 401 dès la connexion,
 * meme pour lister les tools — il n'existe pas de mode "anonyme" pour cet
 * endpoint specifique, contrairement a ce que la doc generale laissait penser.
 * On utilise donc l'API publique Binance classique (api.binance.com) pour
 * les donnees de marche, qui elle ne necessite aucune authentification.
 * L'acces via Agent OS reste tente ailleurs (voir server.js /api/portfolio/live
 * avec Codex CLI, qui lui gere l'auth).
 */
export async function getTicker(symbol) {
  return fetchJson(`/ticker/24hr?symbol=${symbol}`);
}

export async function getKlines(symbol, interval = "1h", limit = 48) {
  const raw = await fetchJson(`/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return raw.map((c) => ({
    time: c[0],
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
    volume: +c[5],
  }));
}
