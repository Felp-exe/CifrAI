# Como conectar um LLM no futuro

> **Você NÃO precisa fazer nada disto agora.** O app funciona por completo em modo local. Este guia é para quando decidirem avaliar custos e conectar um modelo.

## O que existe hoje
- ✅ O app (cliente do contrato, ferramentas, validações, tela de configurações).
- ❌ Backend: **não existe**. ❌ Provedor/chave: **não configurados**.

## Passo a passo

### 1. Escolha o provedor
Qualquer um que ofereça *tool/function calling* (por exemplo Anthropic, OpenAI, Google). Antes, avalie:
- **custo por pergunta** (cada pergunta pode gerar 2 a 3 chamadas ao modelo, pois há a rodada das ferramentas);
- **privacidade**: o provedor receberá o texto da conversa e os resultados resumidos das ferramentas (valores, descrições de transações em lista curta). Leia a política de dados do provedor;
- limites e preços do plano gratuito, se houver.

### 2. Escolha onde hospedar o backend
Algo pequeno e com *secrets*: Cloudflare Workers, Vercel/Netlify Functions, um servidor próprio etc. O front-end continua um site estático.

### 3. Implemente os dois endpoints
Siga `docs/API-BACKEND.md`: `GET /v1/health` e `POST /v1/agent/turn`. A chave de API entra **só** como variável secreta do servidor.

Esqueleto **ilustrativo** (pseudocódigo — não foi testado contra nenhum provedor real):
```js
// Cloudflare Worker, esboço. A chave vem de env.LLM_API_KEY (secret), nunca do front-end.
export default {
  async fetch(request, env) {
    const cors = { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname === '/v1/health') return json({ ok: true, protocolVersion: 1, provider: 'meu-provedor', model: env.MODEL }, cors);
    if (url.pathname === '/v1/agent/turn' && request.method === 'POST') {
      const body = await request.json();
      // 1) valide o tamanho e o protocolo; 2) monte a chamada ao provedor com SYSTEM_PROMPT + body.messages + body.tools;
      // 3) converta a resposta do provedor para { type: 'message' } ou { type: 'tool_calls' }.
      const reply = await callProvider(env.LLM_API_KEY, body); // você implementa
      return json(reply, cors);
    }
    return new Response('Not found', { status: 404, headers: cors });
  },
};
```

### 4. Proteja o backend
Origem permitida (CORS) = o endereço do seu site; limite de requisições; limite de tamanho; sem logs com dados financeiros. Veja o checklist em `docs/API-BACKEND.md`.

### 5. Conecte no app
0. **Libere o endereço na regra de segurança.** O `index.html` tem uma regra (Content-Security-Policy) com `connect-src 'self'`, que só deixa o app falar com o próprio site. Troque por `connect-src 'self' https://seu-backend.exemplo.com` (o endereço exato do seu backend, nunca `https:` inteiro) e publique o arquivo de novo. Sem isso o navegador bloqueia a conexão e o assistente continua no modo local.
1. Abra a aba **Assistente** → **Configurações do assistente**.
2. Cole o endereço do backend (`https://...`, sem `?parâmetros`) e clique em **Salvar endereço**.
3. Clique em **Testar conexão**. Deve aparecer "Backend respondeu" com o provedor/modelo.
4. Selecione **IA conectada**. A faixa no topo do assistente muda para "IA conectada · seu-backend".

### 6. Teste antes de confiar
Faça as 10 perguntas de exemplo e confira, na seção **Dados consultados** de cada resposta, se os números do texto batem com os dados das ferramentas. Se o modelo disser algo que as ferramentas não mostraram, ajuste o prompt de sistema (veja `docs/API-BACKEND.md`).

## O que NUNCA fazer
- ❌ Colocar a chave de API no HTML, CSS, JavaScript, LocalStorage ou em qualquer arquivo do front-end. O app **não tem** campo para chave de propósito.
- ❌ Colocar chave ou token na URL do backend (o app recusa endereços com `?`).
- ❌ Dar ao modelo ferramentas que gravam dados sem confirmação.
- ❌ Enviar PDFs ou o banco de dados inteiro ao backend.

## Trocar de provedor
Só o backend muda. O contrato e o app permanecem iguais.
