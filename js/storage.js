// Preferências simples (LocalStorage).
// LocalStorage guarda pouca coisa e só texto: serve para configurações pequenas
// (ex.: tema, modo do assistente). Os dados financeiros ficam no IndexedDB (db.js).

const PREFIX = 'mfa:';

const DEFAULTS = {
  assistantMode: 'local',   // 'local' (sem IA generativa) ou 'llm' (IA conectada, só com backend configurado)
  rulesUpdateNotice: null,                    // aviso único: regras iniciais atualizadas e quantas transações mudaram
  lastBackup: null,                          // data/hora do último backup exportado (só um lembrete)
  dashboardPeriod: null,                      // último filtro de período usado no Painel
  dashboardCustom: { start: '', end: '' },    // datas do período personalizado
  rememberCorrections: true, // criar regra automaticamente ao corrigir uma categoria
  llmEndpoint: '',          // endereço do backend seguro; a chave de API NUNCA fica aqui
};

export function getSetting(name) {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    return raw === null ? DEFAULTS[name] : JSON.parse(raw);
  } catch {
    return DEFAULTS[name];
  }
}

export function setSetting(name, value) {
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(value));
    return true;
  } catch {
    return false; // navegador bloqueou o armazenamento
  }
}
