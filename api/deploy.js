export const config = { runtime: 'edge' };

// Publica uma proposta HTML direto no Vercel do Diogo, sem passo manual.
// Requer env vars no projeto: VERCEL_TOKEN (Account Settings > Tokens) e VERCEL_TEAM_ID (team_30Wzunp2g4tyoeusIrjSiZtc).
export default async function handler(req) {
  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let name, html;
  try {
    const body = JSON.parse(await req.text());
    name = (body.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    html = body.html;
  } catch (e) {
    return json({ error: 'Body invalido: ' + e.message }, 400);
  }
  if (!name || !html) return json({ error: 'Informe name e html' }, 400);

  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token) return json({ error: 'VERCEL_TOKEN nao configurado no projeto (Settings > Environment Variables). Sem ele, use o botao Baixar HTML e publique manualmente.' }, 500);

  const qs = teamId ? '?teamId=' + encodeURIComponent(teamId) : '';
  const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' };

  try {
    const create = await fetch('https://api.vercel.com/v13/deployments' + qs, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: name,
        target: 'production',
        files: [{ file: 'index.html', data: html }],
        projectSettings: { framework: null }
      })
    });
    const dep = await create.json();
    if (dep.error) return json({ error: 'Vercel: ' + (dep.error.message || JSON.stringify(dep.error)) }, 500);

    // aguarda ficar READY (deploy estatico costuma levar poucos segundos)
    let state = dep.readyState || dep.state || 'QUEUED';
    let info = dep;
    for (let i = 0; i < 12 && state !== 'READY' && state !== 'ERROR'; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const chk = await fetch('https://api.vercel.com/v13/deployments/' + dep.id + qs, { headers: auth });
      info = await chk.json();
      state = info.readyState || info.state || state;
    }
    if (state === 'ERROR') return json({ error: 'Deploy falhou no Vercel. Confira o painel.' }, 500);

    // escolhe o alias mais curto (tipo proposta-nome.vercel.app)
    let url = 'https://' + (info.url || dep.url);
    const aliases = info.alias || [];
    if (aliases.length) {
      const curto = aliases.slice().sort((a, b) => a.length - b.length)[0];
      url = 'https://' + curto;
    }
    return json({ url: url, state: state, deploymentId: dep.id });
  } catch (e) {
    return json({ error: 'Erro ao publicar: ' + e.message }, 500);
  }
}
