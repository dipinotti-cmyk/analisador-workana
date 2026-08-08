export const config = { runtime: 'edge' };
const APP = 'analisador_workana';

// Busca de fotos para o esboço de site (site/landing/loja). Ver spec:
// "Analisador Workana — trocar a maquete por esboço completo de site", secao 4.
//
// Descarta qualquer foto de acervo PAGO (Unsplash+). Checa os tres sinais,
// porque nome de campo muda sem aviso e a URL nao mente.
function ehPaga(p) {
  const urls = p.urls || {};
  const alvo = String(urls.raw || urls.regular || urls.full || '');
  if (alvo.indexOf('plus.unsplash.com') !== -1) return true;
  if (alvo.indexOf('premium_photo-') !== -1) return true;
  if (alvo.indexOf('premium_vector-') !== -1) return true;
  if (p.premium === true || p.plus === true) return true;
  return false;
}

async function buscarUnsplash(q, n, key) {
  const alvo = 'https://api.unsplash.com/search/photos'
    + '?query=' + encodeURIComponent(q)
    + '&per_page=' + Math.min(n * 2, 30)   // pede a mais, porque o filtro corta
    + '&orientation=landscape'
    + '&content_filter=high';
  const r = await fetch(alvo, {
    headers: { 'Authorization': 'Client-ID ' + key, 'Accept-Version': 'v1' }
  });
  if (!r.ok) throw new Error('Unsplash ' + r.status);
  const d = await r.json();
  return (d.results || []).filter(function (p) { return !ehPaga(p); }).map(function (p) {
    const base = (p.urls || {}).raw || (p.urls || {}).regular;
    return {
      fonte: 'unsplash',
      url: base + '&auto=format&fit=crop&w=1600&q=72',
      thumb: base + '&auto=format&fit=crop&w=700&q=68',
      alt: p.alt_description || p.description || q,
      autor: (p.user || {}).name || '',
      perfil: ((p.user || {}).links || {}).html
        ? (p.user.links.html + '?utm_source=' + APP + '&utm_medium=referral')
        : '',
      download: (p.links || {}).download_location || ''
    };
  });
}

async function buscarPexels(q, n, key) {
  const alvo = 'https://api.pexels.com/v1/search'
    + '?query=' + encodeURIComponent(q)
    + '&per_page=' + Math.min(n, 30)
    + '&orientation=landscape';
  const r = await fetch(alvo, { headers: { 'Authorization': key } });
  if (!r.ok) throw new Error('Pexels ' + r.status);
  const d = await r.json();
  return (d.photos || []).map(function (p) {
    const src = p.src || {};
    return {
      fonte: 'pexels',
      url: src.large2x || src.large || src.landscape,
      thumb: src.large || src.medium || src.landscape,
      alt: p.alt || q,
      autor: p.photographer || '',
      perfil: p.photographer_url || '',
      download: ''
    };
  });
}

export default async function handler(req) {
  const json = (o, s) => new Response(JSON.stringify(o), {
    status: s || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
  const u = new URL(req.url);
  const q = (u.searchParams.get('q') || '').trim().slice(0, 80);
  const n = Math.min(parseInt(u.searchParams.get('n') || '10', 10) || 10, 24);
  if (!q) return json({ fotos: [], erro: 'informe q' });
  const kU = process.env.UNSPLASH_ACCESS_KEY;
  const kP = process.env.PEXELS_API_KEY;
  const avisos = [];
  let fotos = [];
  if (kU) {
    try { fotos = await buscarUnsplash(q, n, kU); }
    catch (e) { avisos.push(e.message); }
  } else {
    avisos.push('UNSPLASH_ACCESS_KEY nao configurada');
  }
  // segunda fonte: entra quando a primeira falhou ou devolveu pouca coisa
  if (fotos.length < Math.min(n, 6) && kP) {
    try {
      const extra = await buscarPexels(q, n, kP);
      fotos = fotos.concat(extra);
    } catch (e) { avisos.push(e.message); }
  }
  return json({ fotos: fotos.slice(0, n), avisos: avisos });
}
