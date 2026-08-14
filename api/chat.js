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
// 14/08/2026 — correção do "abortado (AbortError) | sem tempo para tentar o
// próximo". A cascata de 5 modelos era uma FICÇÃO sempre que o 1º modelo
// demorava. O timer de abort dava ao PRIMEIRO modelo quase TODO o prazo global
// (restante - 2500 ≈ 15,5s de 18s), então um único modelo lento consumia o
// orçamento inteiro e nunca sobrava tempo para os "lite" da cascata. O erro
// da tela era isso: gemini-3.5-flash (que PENSA, é o mais lento) liderando,
// estourava o teto e abortava, deixando "sem tempo" para o resto. Agora cada
// modelo tem TETO PRÓPRIO (TETO_MODELO_MS): o prazo é REPARTIDO, então quando o
// primeiro trava a cascata cai de verdade para o próximo. O prazo global também
// subiu para perto do limite real da Vercel (25s), dando espaço para 2 ou 3
// tentativas de verdade dentro da mesma requisição.
//
// Pra fixar um modelo específico sem mexer no código, criar a variável de
// ambiente GEMINI_MODEL na Vercel — ela entra na frente da cascata.
//
// A chave é lida de GEMINI_API_KEY e, se não existir, de OPENAI_API_KEY.

export const config = { runtime: 'edge' };

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// 03/08/2026, fim da tarde — correção do "nenhum modelo respondeu a tempo".
// A cascata anterior estava furada por dois motivos:
//   - gemini-2.5-flash foi aposentado e devolve 404 para chave nova. Era uma
//     posição da cascata jogada fora.
//   - o 1º e o 3º candidato eram o MESMO modelo. Quando o erro é cota (429), a
//     cota é POR MODELO: repetir o mesmo modelo dá 429 de novo, garantido.
// Agora cada posição é um modelo diferente, com balde de cota separado, e os
// dois "lite" existem justamente porque têm limite diário bem maior no plano
// gratuito. Quando a cota do bom acabar, o analisador continua de pé no lite.
const CANDIDATOS = [
  { model: 'gemini-3.5-flash', reasoning_effort: 'low' },
  { model: 'gemini-3.5-flash-lite', reasoning_effort: 'none' },
  { model: 'gemini-3.1-flash-lite', reasoning_effort: 'none' },
  { model: 'gemini-3.6-flash', reasoning_effort: 'low' },
  { model: 'gemini-3.5-flash-lite' }
];

// Reconhece o 429 de cota estourada (o que fala em quota/billing) para não
// insistir no mesmo modelo. Esperar 2,5s não resolve cota: ou é diária, e só
// volta na virada, ou é por minuto, e precisaria de 60s. Nos dois casos o certo
// é pular para o próximo modelo na hora.
const ehCota = (txt) => /RESOURCE_EXHAUSTED|exceeded your current quota|billing details|quota/i.test(txt || '');
const ehDiaria = (txt) => /PerDay|per day|FreeTier/i.test(txt || '');

// Quanto cada nivel de reasoning_effort gasta pensando, segundo a doc da
// Gemini. Esse valor e SOMADO ao teto de saida, nunca descontado dele.
const FOLGA_THINKING = { none: 0, low: 1500, medium: 9000, high: 26000 };

const TETO_ABSOLUTO = 32000;

// Prazo global. A Edge Function da Vercel precisa COMECAR a responder em 25s
// (doc oficial); passando disso, ela e morta e devolve HTML. Ficamos abaixo com
// folga, para a resposta ser sempre JSON, mesmo quando da errado. Subiu de 18s
// para 23s porque os 7s ociosos que sobravam eram justamente o que faltava para
// a cascata tentar um segundo modelo.
const PRAZO_MS = 23000;

// Teto de tempo POR MODELO. Sem isso, o primeiro candidato herdava quase todo o
// PRAZO_MS e, se travasse, nao sobrava nada para os proximos — a cascata inteira
// virava enfeite. Com um teto por modelo o prazo e REPARTIDO. 13s deixa o modelo
// bom TERMINAR uma geracao pesada normal (a landing tem 2600 tokens e leva uns
// 10-13s), sem rebaixar a qualidade a toa; passando disso ele aborta e o lite
// (rapido) ainda pega a vez com os ~7,5s que sobram. Um 429 de cota nao consome
// esse tempo — volta na hora — entao a cascata continua fluindo rapido nesse caso.
const TETO_MODELO_MS = 13000;

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
  const ESPERA_5XX_MS = 1200;
  const PASSADAS = 2;

  // Diagnóstico do motivo real da falha, para a mensagem final ser útil em vez
  // de despejar JSON cru numa caixa de alerta.
  let houveCota = false;
  let houveDiaria = false;

  try {
    for (const candidato of fila) {
      // 5000 (nao mais 6000) porque com o teto por modelo um "lite", que
      // responde em 2-4s, ainda cabe no que sobra e vale a pena tentar.
      if (restante() < 5000) {
        tentativas.push('sem tempo para tentar ' + candidato.model);
        break;
      }

      let resultado = null;
      let abortouCandidato = false;

      for (let passada = 0; passada < PASSADAS; passada++) {
        const tetoSaida = Math.min(maxTokens * (passada + 1), TETO_ABSOLUTO);
        let r = null;
        let detalhe = '';

        // Aborta a chamada sozinho quando o tempo aperta, em vez de deixar a
        // Vercel matar a funcao e devolver HTML. O teto e o MENOR entre o teto
        // por modelo (para a cascata poder cair para o proximo) e o que sobra do
        // prazo global menos a folga de 2,5s para devolver o JSON. O piso de 3s
        // garante que ate o ultimo candidato tenha uma chance real.
        const ctrl = new AbortController();
        const limiteModelo = Math.min(TETO_MODELO_MS, restante() - 2500);
        const corta = setTimeout(function(){ ctrl.abort(); }, Math.max(3000, limiteModelo));

        try {
          // 429 NUNCA repete no mesmo modelo: cota e por modelo, entao repetir
          // da 429 de novo. So o 5xx (solucao da Gemini) merece uma segunda
          // tentativa, e uma so.
          for (let tentativa = 0; tentativa < 2; tentativa++) {
            r = await chamar(candidato, tetoSaida, ctrl.signal);
            if (r.ok) break;
            // 800 chars porque o "quotaId" que diz se e limite DIARIO ou por
            // minuto vem la no fim do corpo do erro. Isso nao vai pra tela.
            detalhe = (await r.text()).slice(0, 800);
            if (r.status === 429) {
              if (ehCota(detalhe)) houveCota = true;
              if (ehDiaria(detalhe)) houveDiaria = true;
              break;
            }
            if (r.status < 500 || tentativa === 1 || restante() < 8000) break;
            await espera(ESPERA_5XX_MS);
          }
        } catch (e) {
          clearTimeout(corta);
          tentativas.push(candidato.model + ' -> abortado (' + (e && e.name) + ')');
          abortouCandidato = true;
          break;
        }
        clearTimeout(corta);

        if (!r || !r.ok) {
          // Rotulo curto de proposito. Despejar o JSON de erro inteiro so
          // enchia a caixa de alerta e escondia a informacao que importa.
          const st = r ? r.status : 0;
          let rotulo = st + '';
          if (st === 429) rotulo = '429 cota estourada';
          else if (st === 404) rotulo = '404 modelo aposentado';
          else if (st === 400) rotulo = '400 pedido recusado';
          else if (st >= 500) rotulo = st + ' erro da Gemini';
          else if (!r) rotulo = 'sem resposta';
          tentativas.push(candidato.model + ' -> ' + rotulo);
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

    // Quando o motivo e cota, a mensagem tem que dizer o que fazer. A anterior
    // dizia "nenhum modelo respondeu a tempo", que era ate mentira: os modelos
    // responderam rapido, so que respondendo que a cota acabou.
    if (houveCota) {
      return json({
        error: houveDiaria
          ? 'A cota gratuita diaria da Gemini acabou. Ela vira a meia-noite do horario do Pacifico, o que aqui da por volta das 4h/5h da manha. Ate la, da pra trocar a chave em GEMINI_API_KEY por uma de outra conta Google, ou ativar faturamento no projeto.'
          : 'A Gemini recusou por limite de uso em todos os modelos da cascata. Espere um minuto e tente de novo. Se continuar, e a cota do dia que acabou e ela volta na virada.',
        codigo: 'cota',
        tentativas: tentativas.join(' | ')
      }, 429);
    }

    return json({
      error: 'Nenhum modelo da Gemini respondeu. Tentativas: ' + tentativas.join(' | '),
      tentativas: tentativas.join(' | ')
    }, 502);
  } catch (e) {
    return json({ error: 'Erro na chamada da Gemini: ' + e.message }, 500);
  }
}
