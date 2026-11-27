// Camada de banco de dados local (IndexedDB).
// IndexedDB é um banco que mora dentro do seu navegador: não precisa de servidor,
// de login nem de internet. Aqui escondemos a parte difícil atrás de funções simples.

export const DB_NAME = 'my-finance-agent';
// Versão 2 (Etapa 2): adiciona a tabela "imports" e o índice "importId".
// Versão 3 (Etapa 4): adiciona a tabela "receiptLinks" (vínculo entre entradas reais e ciclos).
// Ao abrir, o navegador só acrescenta o que falta: os dados das versões anteriores são preservados.
export const DB_VERSION = 3;

/** "Tabelas" do banco e como cada uma é organizada. */
const SCHEMA = {
  // Cada transação guarda a descrição ORIGINAL do extrato e o nome NORMALIZADO.
  transactions: {
    options: { keyPath: 'id', autoIncrement: true },
    indexes: ['date', 'categoryId', 'status', 'fingerprint', 'type', 'importId'],
  },
  // Histórico de importações de extratos (um registro por arquivo importado).
  imports: { options: { keyPath: 'id' }, indexes: ['importedAt'] },
  categories: { options: { keyPath: 'id' }, indexes: [] },
  rules: { options: { keyPath: 'id', autoIncrement: true }, indexes: ['pattern', 'categoryId'] },
  budgets: { options: { keyPath: 'id', autoIncrement: true }, indexes: ['categoryId', 'month'] },
  incomes: { options: { keyPath: 'id', autoIncrement: true }, indexes: ['day'] },
  // Alocações MANUAIS de despesas a ciclos (as automáticas são calculadas na hora e não são gravadas).
  allocations: { options: { keyPath: 'id', autoIncrement: true }, indexes: ['transactionId', 'cycleId'] },
  // Vínculo manual de uma entrada real (ex.: salário no extrato) com um ciclo de recebimento.
  receiptLinks: { options: { keyPath: 'id', autoIncrement: true }, indexes: ['transactionId', 'cycleId'] },
  meta: { options: { keyPath: 'key' }, indexes: [] },
};

export const STORE_NAMES = Object.keys(SCHEMA);

/** Converte um pedido do IndexedDB (com callbacks) em uma Promise (com await). */
function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class Database {
  constructor(name = DB_NAME) {
    this.name = name;
    this.db = null;
  }

  /** Abre (e cria, na primeira vez) o banco. */
  open() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in globalThis)) {
        reject(new Error('Este navegador não oferece IndexedDB.'));
        return;
      }
      const request = indexedDB.open(this.name, DB_VERSION);
      request.onupgradeneeded = () => this._createSchema(request.result, request.transaction);
      request.onsuccess = () => {
        this.db = request.result;
        // Se outra aba do app precisar atualizar o banco, fechamos esta conexão para não travá-la.
        this.db.onversionchange = () => { this.db.close(); this.db = null; this.onOutdated?.(); };
        resolve(this);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Feche outras abas do app e tente novamente.'));
    });
  }

  // Cria o que falta (tabelas e índices) sem apagar nada que já existe.
  _createSchema(db, upgradeTx) {
    for (const [name, def] of Object.entries(SCHEMA)) {
      const store = db.objectStoreNames.contains(name)
        ? upgradeTx.objectStore(name)
        : db.createObjectStore(name, def.options);
      for (const index of def.indexes) {
        if (!store.indexNames.contains(index)) store.createIndex(index, index, { unique: false });
      }
    }
  }

  /**
   * Executa várias gravações em tabelas diferentes como UMA operação "tudo ou nada":
   * se qualquer parte falhar, nada fica salvo pela metade.
   */
  transact(storeNames, work) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeNames, 'readwrite');
      const stores = Object.fromEntries(storeNames.map((n) => [n, tx.objectStore(n)]));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Gravação cancelada.'));
      try { work(stores); } catch (error) { tx.abort(); reject(error); }
    });
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }

  _store(name, mode = 'readonly') {
    if (!this.db) throw new Error('Banco ainda não foi aberto.');
    return this.db.transaction(name, mode).objectStore(name);
  }

  getAll(store) { return promisify(this._store(store).getAll()); }
  get(store, key) { return promisify(this._store(store).get(key)); }
  count(store) { return promisify(this._store(store).count()); }
  add(store, item) { return promisify(this._store(store, 'readwrite').add(item)); }
  put(store, item) { return promisify(this._store(store, 'readwrite').put(item)); }
  delete(store, key) { return promisify(this._store(store, 'readwrite').delete(key)); }
  clear(store) { return promisify(this._store(store, 'readwrite').clear()); }

  getAllByIndex(store, index, value) {
    return promisify(this._store(store).index(index).getAll(value));
  }

  /** Grava vários itens de uma vez. Se um falhar, nenhum é gravado (tudo ou nada). */
  bulkPut(store, items) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const item of items) os.put(item);
      tx.oncomplete = () => resolve(items.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // Valores soltos (ex.: "já carreguei os dados iniciais?")
  async getMeta(key) {
    const row = await this.get('meta', key);
    return row ? row.value : undefined;
  }
  setMeta(key, value) { return this.put('meta', { key, value }); }
}

/** Apaga um banco inteiro (usado pelos testes). */
export function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
