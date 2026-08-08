export const config = { runtime: 'edge' };

// Dispara o "download trigger" que o Unsplash exige quando uma foto da busca
// e efetivamente usada numa pagina publicada (obrigacao de licenca, secao 4.5
// da spec do esboco). O front chama isto uma vez por foto, so para fotos com
// fonte "unsplash" (o Pexels nao tem esse passo), no momento em que o HTML e
// montado. Falha aqui nunca pode aparecer pro Diogo nem pro cliente: por isso
// o handler inteiro e best-effort e sempre devolve 204, mesmo em erro.
//
// Env var necessaria no projeto analisador-workana:
//   UNSPLASH_ACCESS_KEY = a mesma chave usada em api/foto.js

export default async function handler(req) {
  const vazio = (status) => new Response(null, {
    status: status || 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });

  if (req.method === 'OPTIONS') return vazio(204);

  let alvo = '';
  try {
    const u = new URL(req.url);
    alvo = (u.searchParams.get('u') || '').slice(0, 500);
  } catch (e) {
    return vazio(204);
  }

  if (!alvo) return vazio(204);
  // so aceita URL do proprio Unsplash: nunca vira um proxy de fetch aberto
  if (!/^https:\/\/api\.unsplash\.com\//.test(alvo)) return vazio(204);

  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return vazio(204);

  try {
    await fetch(alvo, {
      headers: { 'Authorization': 'Client-ID ' + key, 'Accept-Version': 'v1' }
    });
  } catch (e) {
    // silencio proposital: falha de registro nao pode aparecer pro cliente
  }

  return vazio(204);
}
