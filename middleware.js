import { next } from '@vercel/functions';

// Gate de senha (Basic Auth) para a versao de apresentacao do analisador.
//
// COMO LIGA/DESLIGA: so bloqueia se a variavel de ambiente APP_SENHA estiver
// definida na Vercel. Sem ela, libera tudo (fail-open) — ou seja, mergear este
// arquivo NAO muda nada ate voce criar APP_SENHA nas Environment Variables do
// projeto. Isso evita travar o app por engano perto da apresentacao.
//
// O QUE PROTEGE: a tela do app e todas as APIs, MENOS /api/view. Esse fica
// PUBLICO de proposito, porque quem chama /api/view e a PROPOSTA PUBLICADA (que
// roda em outro dominio, no navegador do seu cliente, sem senha) para registrar
// a abertura. Se /api/view exigisse senha, o status "visualizada" no CRM
// pararia de funcionar.
export const config = {
  matcher: ['/((?!api/view).*)'],
};

export default function middleware(request) {
  const senha = process.env.APP_SENHA;

  // Sem senha configurada: nao bloqueia nada.
  if (!senha) return next();

  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    let decodificado = '';
    try {
      decodificado = atob(auth.slice(6)); // formato "usuario:senha"
    } catch (e) {
      decodificado = '';
    }
    const sep = decodificado.indexOf(':');
    const informada = sep >= 0 ? decodificado.slice(sep + 1) : '';
    // Usuario e ignorado de proposito: basta a senha bater.
    if (informada === senha) return next();
  }

  return new Response('Acesso restrito.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Peneira Trampo", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
