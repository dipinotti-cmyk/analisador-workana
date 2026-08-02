export const config = { runtime: 'edge' };

// Registra a ABERTURA de uma proposta publicada.
//
// Por que existe: o CRM sabia quando a proposta foi enviada, mas nunca se o
// cliente chegou a abrir o link. Sem isso, "nao abriu" e "abriu e ignorou"
// pareciam a mesma coisa — e sao problemas opostos. Nao abriu e problema de
// mensagem e posicionamento; abriu e nao respondeu e problema de preco e oferta.
//
// A pagina publicada chama este endpoint com fetch em modo no-cors. Nenhuma
// chave do Supabase vai junto no HTML publico: quem escreve no banco e o
// servidor, aqui. Nenhum dado do visitante e guardado alem do referer.
//
// Env vars necessarias no projeto analisador-workana:
//   SB_URL  = https://sxfixxirixbmcvsswpvh.supabase.co
//   SB_KEY  = a mesma chave anon ja usada pelo app
//
// Tabela esperada (SQL no README / conversa):
//   proposta_views(id, slug, cliente, aberto_em, referer)

export default async function handler(req) {
  const vazio = (status) => new Response(null, {
    status: status || 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });

  if (req.method === 'OPTIONS') return vazio(204);

  let slug = '', cliente = '';
  try {
    const u = new URL(req.url);
    slug = (u.searchParams.get('slug') || '').slice(0, 120);
    cliente = (u.searchParams.get('c') || '').slice(0, 120);
  } catch (e) {
    return vazio(204);
  }

  // Sem slug nao ha o que registrar. Responde 204 assim mesmo: este endpoint
  // nunca pode quebrar a pagina do cliente por causa de um erro nosso.
  if (!slug) return vazio(204);

  const url = process.env.SB_URL;
  const key = process.env.SB_KEY;
  if (!url || !key) return vazio(204);

  try {
    await fetch(url + '/rest/v1/proposta_views', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        slug: slug,
        cliente: cliente || null,
        referer: (req.headers.get('referer') || '').slice(0, 300) || null
      })
    });
  } catch (e) {
    // silencio proposital: falha de registro nao pode aparecer pro cliente
  }

  return vazio(204);
}
