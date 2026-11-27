// Tela inicial: explica o que o site faz, como começar e o que ele oferece.
// É a primeira coisa que colegas e professores veem, então o texto é simples e sem jargão.
import { icons } from './icons.js';
import { useSampleStatement } from './importar.js';

const STEPS = [
  ['Importe o extrato', 'Baixe o extrato em PDF no app ou no site do seu banco e envie aqui. A leitura acontece no seu navegador.'],
  ['Revise as categorias', 'O app sugere uma categoria para cada gasto. Você confere, corrige o que quiser e ele aprende com você.'],
  ['Acompanhe e planeje', 'Veja gráficos, defina orçamentos por categoria e acompanhe quanto já gastou em cada uma.'],
];

const FEATURES = [
  ['upload', 'Importação de PDF', 'Lê o extrato e mostra tudo para você revisar antes de salvar. Nada entra sem a sua confirmação.'],
  ['list', 'Categorias automáticas', 'Reconhece iFood, Uber, farmácias, mercados e muito mais. Você também cria as suas próprias categorias e regras.'],
  ['target', 'Orçamentos', 'Defina quanto quer gastar em cada categoria e veja quando estiver perto do limite.'],
  ['dashboard', 'Painel com gráficos', 'Receitas, despesas, evolução do saldo e gastos por categoria em gráficos fáceis de ler.'],
  ['chat', 'Assistente', 'Faça perguntas em português sobre os seus gastos e receba respostas calculadas com os seus próprios dados.'],
  ['archive', 'Backup e controle', 'Exporte uma cópia dos seus dados quando quiser, restaure depois e apague tudo com um clique.'],
];

export async function render(container, ctx) {
  const hasData = (await ctx.db.count('transactions')) > 0;
  container.innerHTML = `
    <div class="home">
      <section class="hero" aria-labelledby="home-title">
        <div>
          <span class="eyebrow">Controle financeiro pessoal · gratuito · sem cadastro</span>
          <h1 id="home-title">Entenda para onde vai o <em>seu dinheiro</em></h1>
          <p class="hero-lead">O CifrAI lê o extrato do seu banco em PDF, organiza seus gastos por categoria e mostra, de forma simples, onde você pode economizar.</p>
          <div class="hero-actions">
            <a class="btn primary large" href="#/importar">Começar agora</a>
            <button class="btn large" type="button" data-act="sample">Testar com um extrato de exemplo</button>
            ${hasData ? '<a class="btn large" href="#/painel">Abrir meu painel</a>' : ''}
          </div>
          <p class="hero-note">Leva poucos minutos. Seus dados ficam só no seu navegador.</p>
          <p id="home-msg" class="settings-msg" role="status"></p>
        </div>
        <div class="hero-preview" aria-hidden="true">
          <span class="label">Exemplo do painel · dados fictícios</span>
          <div class="mini-stats">
            <div class="mini-stat mint"><span>Receitas</span><strong>R$ 3.550,00</strong></div>
            <div class="mini-stat rose"><span>Despesas</span><strong>R$ 1.883,36</strong></div>
          </div>
          <div class="mini-bars">
            <div class="mini-bar"><span>Moradia</span><i class="b1"></i></div>
            <div class="mini-bar"><span>Alimentação</span><i class="b2"></i></div>
            <div class="mini-bar"><span>Transporte</span><i class="b3"></i></div>
            <div class="mini-bar"><span>Saúde</span><i class="b4"></i></div>
          </div>
        </div>
      </section>

      <section class="home-section" aria-labelledby="how-title">
        <h2 id="how-title">Como funciona</h2>
        <p class="lead">Três passos, sem instalar nada e sem criar conta.</p>
        <ol class="steps">
          ${STEPS.map(([title, text], i) => `<li class="step"><span class="step-number" aria-hidden="true">${i + 1}</span><h3>${title}</h3><p>${text}</p></li>`).join('')}
        </ol>
      </section>

      <section class="home-section" aria-labelledby="features-title">
        <h2 id="features-title">O que você encontra aqui</h2>
        <p class="lead">Tudo o que você precisa para se organizar, em um só lugar.</p>
        <ul class="features">
          ${FEATURES.map(([icon, title, text]) => `<li class="feature"><span class="feature-icon">${icons[icon]}</span><h3>${title}</h3><p>${text}</p></li>`).join('')}
        </ul>
      </section>

      <section class="privacy-band" aria-labelledby="privacy-title">
        <span class="feature-icon">${icons.shield}</span>
        <div>
          <h2 id="privacy-title">Seus dados ficam só com você</h2>
          <p>Não há login, cadastro nem servidor. Os PDFs são lidos dentro do seu navegador e as informações ficam guardadas nele. Ninguém recebe o seu extrato, nem este site.</p>
        </div>
      </section>

      <section class="cta-band" aria-labelledby="cta-title">
        <h2 id="cta-title">Pronto para organizar suas finanças?</h2>
        <p>Comece importando o seu extrato ou veja como funciona com um extrato de exemplo.</p>
        <div class="action-buttons center">
          <a class="btn primary large" href="#/importar">Importar meu extrato</a>
          <button class="btn large" type="button" data-act="sample">Ver com extrato de exemplo</button>
        </div>
      </section>

      <p class="home-footer">CifrAI · projeto acadêmico de controle financeiro pessoal. Não substitui orientação financeira profissional.</p>
    </div>`;

  container.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-act="sample"]')) return;
    const msg = container.querySelector('#home-msg');
    msg.textContent = 'Carregando o extrato de exemplo…';
    try {
      await useSampleStatement();
    } catch (error) {
      console.error(error);
      msg.textContent = `Não consegui carregar o extrato de exemplo: ${error.message}`;
    }
  });
}
