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

  try {
    for (const candidato of fila) {
      let r = await chamar(candidato);

      // Limite gratuito por minuto: uma espera curta resolve a maioria.
      if (r.status === 429) {
        await espera(3000);
        r = await chamar(candidato);
      }

      // Modelo inexistente (404) ou parâmetro recusado (400): tenta o próximo
      // da fila em vez de devolver erro na cara do usuário.
      if (r.status === 404 || r.status === 400) {
        let detalhe = '';
        try {
          const corpoErro = await r.json();
          detalhe = corpoErro && corpoErro.error && corpoErro.error.message ? corpoErro.error.message : '';
        } catch (e) {
          detalhe = 'sem corpo de erro';
        }
        tentativas.push(candidato.model + ' -> ' + r.status + (detalhe ? ' (' + detalhe.slice(0, 120) + ')' : ''));
        continue;
      }

      if (r.status === 429) {
        return json({ error: 'Limite gratuito da Gemini atingido. Espere 1 minuto e tente de novo.' }, 429);
      }

      const data = await r.json();

      if (data.error) {
        return json({ error: 'Gemini (' + candidato.model + '): ' + (data.error.message || JSON.stringify(data.error)) }, 500);
      }
      if (!r.ok) {
        return json({ error: 'Gemini (' + candidato.model + ') respondeu ' + r.status + '. Resposta: ' + JSON.stringify(data).slice(0, 300) }, 500);
      }

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
      error: 'Nenhum modelo da Gemini respondeu. Tentativas: ' + tentativas.join(' | ')
    }, 502);
  } catch (e) {
    return json({ error: 'Erro na chamada da Gemini: ' + e.message }, 500);
  }
}
