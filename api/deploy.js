export const config = { runtime: 'edge' };

// Publica a proposta HTML e devolve o link pronto.
//
// 19/08/2026 — MUDANCA DE ESTRUTURA. Antes esta rota criava um PROJETO NOVO na
// Vercel por proposta. Em tres semanas viraram 40 projetos, e limpar os que nao
// deram em nada era excluir um por um, na mao, no painel da Vercel.
//
// Agora a proposta vai pro servico de propostas (lupixa-propostas), onde ela e
// uma LINHA no banco: publicar e um upsert, apagar e um delete, e o endereco
// fica sempre no mesmo dominio. Republicar com o mesmo nome MANTEM o link que
// o cliente ja recebeu, o que antes era impossivel.
//
// Env vars no projeto (Settings > Environment Variables):
//   PROPOSTAS_URL    ex: https://lupixa-propostas.vercel.app
//   PROPOSTAS_TOKEN  o mesmo valor de PUBLICAR_TOKEN la
//
// Enquanto essas duas nao existirem, a rota cai no caminho antigo da Vercel pra
// nao deixar o Diogo sem publicar. O aviso vem junto na resposta.
export default async function handler(req) {
  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let name, html, cliente;
  try {
    const body = JSON.parse(await req.text());
    name = (body.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    html = body.html;
    cliente = body.cliente || null;
  } catch (e) {
    return json({ error: 'Body invalido: ' + e.message }, 400);
  }
  if (!name || !html) return json({ error: 'Informe name e html' }, 400);

  const servico = (process.env.PROPOSTAS_URL || '').replace(/\/+$/, '');
  const tokenServico = process.env.PROPOSTAS_TOKEN;

  if (servico && tokenServico) {
    try {
      const r = await fetch(servico + '/api/publicar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': 'Bearer ' + tokenServico,
        },
        // o prefixo "proposta-" vinha do nome do projeto na Vercel; no endereco
        // novo ele so polui, entao sai aqui.
        body: JSON.stringify({ slug: name.replace(/^proposta-/, ''), html, cliente, origem: 'peneira-trampo' }),
      });
      const dep = await r.json();
      if (!r.ok || dep.error) return json({ error: 'Propostas: ' + (dep.error || 'erro ' + r.status) }, 500);
      return json({ url: dep.url, state: 'READY', via: 'propostas' });
    } catch (e) {
      return json({ error: 'Nao consegui falar com o servico de propostas: ' + e.message }, 500);
    }
  }

  // ---- caminho antigo, um projeto na Vercel por proposta ----
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token) return json({ error: 'Configure PROPOSTAS_URL e PROPOSTAS_TOKEN (ou VERCEL_TOKEN) nas variaveis de ambiente. Sem isso, use o botao Baixar HTML.' }, 500);

  const qs = teamId ? '?teamId=' + encodeURIComponent(teamId) : '';
  const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' };

  try {
    const create = await fetch('https://api.vercel.com/v13/deployments' + qs, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name, target: 'production', files: [{ file: 'index.html', data: html }], projectSettings: { framework: null } })
    });
    const dep = await create.json();
    if (dep.error) return json({ error: 'Vercel: ' + (dep.error.message || JSON.stringify(dep.error)) }, 500);

    let state = dep.readyState || dep.state || 'QUEUED';
    let info = dep;
    for (let i = 0; i < 12 && state !== 'READY' && state !== 'ERROR'; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const chk = await fetch('https://api.vercel.com/v13/deployments/' + dep.id + qs, { headers: auth });
      info = await chk.json();
      state = info.readyState || info.state || state;
    }
    if (state === 'ERROR') return json({ error: 'Deploy falhou no Vercel. Confira o painel.' }, 500);

    const curtoEsperado = name + '.vercel.app';
    let aliases = info.alias || [];
    for (let i = 0; i < 4 && aliases.indexOf(curtoEsperado) === -1; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const chk2 = await fetch('https://api.vercel.com/v13/deployments/' + dep.id + qs, { headers: auth });
      const inf2 = await chk2.json();
      if (inf2.alias && inf2.alias.length) aliases = inf2.alias;
    }
    let host;
    if (aliases.indexOf(curtoEsperado) !== -1) host = curtoEsperado;
    else if (aliases.length) host = aliases.slice().sort((a, b) => a.length - b.length)[0];
    else host = info.url || dep.url;
    return json({
      url: 'https://' + host, state, deploymentId: dep.id, via: 'vercel-projeto',
      aviso: 'Publicado do jeito antigo, criando um projeto na Vercel. Configure PROPOSTAS_URL e PROPOSTAS_TOKEN pra parar de acumular projeto.'
    });
  } catch (e) {
    return json({ error: 'Erro ao publicar: ' + e.message }, 500);
  }
}
