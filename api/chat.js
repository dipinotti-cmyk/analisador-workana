// Analisador Workana — endpoint de IA
// Migrado de OpenAI para Gemini em 29/07/2026 (créditos da OpenAI acabaram e
// não há cartão que passe). Usa a camada de compatibilidade OpenAI da Gemini,
// então o formato de requisição e resposta continua idêntico ao anterior.
//
// 30/07/2026 — correção do 404. O gemini-2.5-flash foi retirado antes da data
// de desligamento anunciada, e a camada de compatibilidade devolve 404 seco,
// sem corpo de erro, quando o modelo não existe mais. Em vez de cravar um
// modelo só, agora existe uma CASCATA: a chamada tenta os modelos na ordem e
// pula pro próximo quando recebe 404 ou 400. Assim a próxima aposentadoria de
// modelo do Google não derruba a ferramenta de novo.
//
// Pra fixar um modelo específico sem mexer no código, basta criar a variável
// de ambiente GEMINI_MODEL na Vercel — ela entra na frente da cascata.
//
// A chave é lida de GEMINI_API_KEY e, se não existir, de OPENAI_API_KEY.
//
// Sobre reasoning_effort: no Gemini 2.5 o valor 'none' desliga o thinking. Na
// família 3.x o mínimo aceito é 'low'. Cada candidato carrega o valor certo, e
// o último da fila vai sem o parâmetro nenhum, como rede de segurança.

export const config = { runtime: 'edge' };

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const CANDIDATOS = [
  { model: 'gemini-3.5-flash', reasoning_effort: 'low' },
  { model: 'gemini-3.1-flash-lite', reasoning_effort: 'low' },
  { model: 'gemini-2.5-flash', reasoning_effort: 'none' },
  { model: 'gemini-3.5-flash' }
];

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' }
});

const espera = (ms) => new Promise(res => setTimeout(res, ms));

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let prompt, maxTokens;
  try {
    const body = JSON.parse(await req.text());
    prompt = body.prompt;
    maxTokens = Math.min(Math.max(parseInt(body.max_tokens) || 1000, 100), 16000);
  } catch (e) {
    return json({ error: 'Body invalido: ' + e.message }, 400);
  }

  if (!prompt) {
    return json({ error: 'Prompt vazio' }, 400);
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json({ error: 'Chave nao configurada no servidor (GEMINI_API_KEY)' }, 500);
  }

  const fila = process.env.GEMINI_MODEL
    ? [{ model: process.env.GEMINI_MODEL, reasoning_effort: 'low' }, ...CANDIDATOS]
    : CANDIDATOS;

  const chamar = (candidato) => {
    const corpo = {
      model: candidato.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    };
    if (candidato.reasoning_effort) corpo.reasoning_effort = candidato.reasoning_effort;

    return fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(corpo)
    });
  };

  const tentativas = [];
  const ESPERAS_MS = [2000, 5000];

  try {
    for (const candidato of fila) {
      let r = null;
      let detalhe = '';

      // So o 429 (limite por minuto) merece insistir no MESMO modelo, porque
      // e questao de esperar. 503 significa modelo sobrecarregado do lado do
      // Google, e 404/400 sao definitivos: nos tres casos trocar de modelo e
      // mais rapido que esperar, entao cai direto pro proximo da fila.
      for (let tentativa = 0; tentativa <= ESPERAS_MS.length; tentativa++) {
        r = await chamar(candidato);
        if (r.ok) break;
        detalhe = (await r.text()).slice(0, 200);
        const temporario = r.status === 429;
        if (!temporario || tentativa === ESPERAS_MS.length) break;
        await espera(ESPERAS_MS[tentativa]);
      }

      // Qualquer falha que sobreviveu as tentativas: proximo modelo da fila.
      if (!r.ok) {
        tentativas.push(candidato.model + ' -> ' + r.status + ' ' + detalhe);
        continue;
      }

      const data = await r.json();
      const choice = data.choices && data.choices[0];
      const text = (choice && choice.message && choice.message.content) || '';

      if (!text) {
        const motivo = (choice && choice.finish_reason) || 'sem finish_reason';
        tentativas.push(candidato.model + ' -> vazio (' + motivo + ')');
        continue;
      }

      return json({ text, model: candidato.model }, 200);
    }

    return json({
      error: 'Nenhum modelo da Gemini respondeu agora. Tentativas: ' + tentativas.join(' | ')
    }, 502);
  } catch (e) {
    return json({ error: 'Erro na chamada da Gemini: ' + e.message }, 500);
  }
}
