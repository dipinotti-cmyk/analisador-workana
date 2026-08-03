// Analisador Workana — endpoint de IA
// Migrado de OpenAI para Gemini em 29/07/2026 (créditos da OpenAI acabaram e
// não há cartão que passe). Usa a camada de compatibilidade OpenAI da Gemini,
// então o formato de requisição e resposta continua idêntico ao anterior.
//
// 30/07/2026 — correção do 404, com CASCATA de modelos.
//
// 02/08/2026 — correção da MENSAGEM CORTADA PELA METADE. No Gemini o thinking
// consome o MESMO orçamento do max_tokens; a reserva passou a ser somada por
// cima do que o front pediu, em vez de descontada dele.
//
// 03/08/2026 — correção dos ERROS ALEATÓRIOS. São três causas distintas:
//
//   1. "Resposta invalida do servidor" nunca veio daqui. Vinha da Vercel
//      matando a função por tempo e devolvendo uma PÁGINA HTML de erro, que o
//      front tentava ler como JSON. A cascata de 4 modelos, com 3 tentativas
//      cada, esperas de 2s e 5s e mais uma segunda passada, passava fácil do
//      limite. Agora existe PRAZO GLOBAL: quando o tempo acaba, quem responde
//      somos nós, em JSON, em vez de ser morto pela plataforma.
//
//   2. Erro citando JSON e uma linha específica. Quando o front pede JSON, o
//      modelo às vezes devolve com cerca de markdown ou um "aqui está:" antes
//      do objeto. Pior: quando a resposta vinha cortada, este arquivo GRUDAVA
//      um aviso de texto no fim, o que quebrava o JSON em 100% dos casos.
//      Agora, com json:true, a chamada usa response_format da Gemini (saída
//      JSON pura) e o aviso NUNCA é concatenado — ele volta só no campo
//      truncado, para o front decidir o que fazer.
//
//   3. Lentidão. Cascata encurtada, uma única espera no 429, e a segunda
//      passada só acontece se ainda houver prazo.
//
// Pra fixar um modelo específico sem mexer no código, criar a variável de
// ambiente GEMINI_MODEL na Vercel — ela entra na frente da cascata.
//
// A chave é lida de GEMINI_API_KEY e, se não existir, de OPENAI_API_KEY.

export const config = { runtime: 'edge' };

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Cascata enxuta. Cada modelo a mais é latência a mais no pior caso, e o pior
// caso é justamente o que estourava o tempo da Vercel.
const CANDIDATOS = [
  { model: 'gemini-3.5-flash', reasoning_effort: 'low' },
  { model: 'gemini-2.5-flash', reasoning_effort: 'none' },
  { model: 'gemini-3.5-flash' }
];

// Quanto cada nivel de reasoning_effort gasta pensando, segundo a doc da
// Gemini. Esse valor e SOMADO ao teto de saida, nunca descontado dele.
const FOLGA_THINKING = { none: 0, low: 1500, medium: 9000, high: 26000 };

const TETO_ABSOLUTO = 32000;

// Prazo global. A Vercel corta a execucao em algum ponto acima disso e devolve
// HTML; ficando abaixo, a resposta e sempre JSON, mesmo quando da errado.
const PRAZO_MS = 42000;

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' }
});

const espera = (ms) => new Promise(res => setTimeout(res, ms));

export default async function handler(req) {
  const inicio = Date.now();
  const restante = () => PRAZO_MS - (Date.now() - inicio);

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let prompt, maxTokens, querJson;
  try {
    const body = JSON.parse(await req.text());
    prompt = body.prompt;
    maxTokens = Math.min(Math.max(parseInt(body.max_tokens) || 1000, 100), 16000);
    querJson = body.json === true;
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

  // tetoSaida = quanto de TEXTO a chamada precisa poder gerar. A reserva de
  // pensamento entra em cima disso, porque a Gemini cobra os dois do mesmo
  // orcamento e quem paga a conta quando falta e o texto.
  const chamar = (candidato, tetoSaida, sinal) => {
    const reserva = FOLGA_THINKING[candidato.reasoning_effort] || 0;
    const corpo = {
      model: candidato.model,
      max_tokens: Math.min(tetoSaida + reserva, TETO_ABSOLUTO),
      messages: [{ role: 'user', content: prompt }]
    };
    if (candidato.reasoning_effort) corpo.reasoning_effort = candidato.reasoning_effort;

    // Modo JSON nativo. Acaba com cerca de markdown, com "aqui esta o JSON:"
    // antes do objeto e com comentario depois. E a correcao de raiz do erro
    // que citava linha e coluna.
    if (querJson) corpo.response_format = { type: 'json_object' };

    return fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(corpo),
      signal: sinal
    });
  };

  const tentativas = [];
  const ESPERA_429_MS = 2500;
  const PASSADAS = 2;

  try {
    for (const candidato of fila) {
      if (restante() < 6000) {
        tentativas.push('sem tempo para tentar ' + candidato.model);
        break;
      }

      let resultado = null;
      let abortouCandidato = false;

      for (let passada = 0; passada < PASSADAS; passada++) {
        const tetoSaida = Math.min(maxTokens * (passada + 1), TETO_ABSOLUTO);
        let r = null;
        let detalhe = '';

        // Aborta a chamada sozinho quando o prazo global aperta, em vez de
        // deixar a Vercel matar a funcao e devolver HTML.
        const ctrl = new AbortController();
        const corta = setTimeout(function(){ ctrl.abort(); }, Math.max(3000, restante() - 2500));

        try {
          // So o 429 (limite por minuto) merece insistir no MESMO modelo, e uma
          // espera so: duas custavam mais tempo do que valia o beneficio.
          for (let tentativa = 0; tentativa < 2; tentativa++) {
            r = await chamar(candidato, tetoSaida, ctrl.signal);
            if (r.ok) break;
            detalhe = (await r.text()).slice(0, 160);
            if (r.status !== 429 || tentativa === 1 || restante() < 8000) break;
            await espera(ESPERA_429_MS);
          }
        } catch (e) {
          clearTimeout(corta);
          tentativas.push(candidato.model + ' -> abortado (' + (e && e.name) + ')');
          abortouCandidato = true;
          break;
        }
        clearTimeout(corta);

        if (!r || !r.ok) {
          tentativas.push(candidato.model + ' -> ' + (r ? r.status : '?') + ' ' + detalhe);
          abortouCandidato = true;
          break;
        }

        const data = await r.json();
        const choice = data.choices && data.choices[0];
        const texto = (choice && choice.message && choice.message.content) || '';
        const motivo = (choice && choice.finish_reason) || '';

        // Vazio de verdade: o thinking comeu tudo ou o modelo nao respondeu.
        // Nao adianta dobrar, e caso de trocar de modelo.
        if (!texto) {
          tentativas.push(candidato.model + ' -> vazio (' + (motivo || 'sem finish_reason') + ')');
          abortouCandidato = true;
          break;
        }

        resultado = { texto: texto, motivo: motivo };

        // Resposta inteira: pode sair. Cortada no limite: repete com o dobro,
        // mas so se ainda sobrar prazo para isso.
        if (motivo !== 'length') break;
        tentativas.push(candidato.model + ' -> cortado com teto ' + tetoSaida);
        if (restante() < 12000) break;
      }

      if (abortouCandidato || !resultado) continue;

      const cortado = resultado.motivo === 'length';

      // ATENCAO: em modo JSON o aviso NUNCA e concatenado ao texto. Concatenar
      // era o que quebrava o JSON.parse do front em todos os casos. O front le
      // o campo truncado e decide o que mostrar.
      const text = (cortado && !querJson)
        ? resultado.texto + '\n\n[!] RESPOSTA CORTADA NO LIMITE DE TOKENS. Clique em Gerar de novo ou reduza o pedido antes de enviar.'
        : resultado.texto;

      return json({ text: text, model: candidato.model, truncado: cortado }, 200);
    }

    return json({
      error: 'Nenhum modelo da Gemini respondeu a tempo. Tentativas: ' + tentativas.join(' | ')
    }, 502);
  } catch (e) {
    return json({ error: 'Erro na chamada da Gemini: ' + e.message }, 500);
  }
}
