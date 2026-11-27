// Exportação: lê o IndexedDB (somente leitura) e monta o objeto do backup.
// Nada é enviado para fora: o arquivo é gerado e salvo no seu computador (veja backupFile.js).
import { BACKUP_FORMAT, BACKUP_VERSION, STORES, FIELDS, META_KEYS, pick } from './backupFormat.js';
import { DB_VERSION } from '../db.js';

const byId = (a, b) => (typeof a.id === 'number' ? a.id - b.id : String(a.id).localeCompare(String(b.id)));

/** Monta o backup com TODOS os dados do app. */
export async function buildBackup(db, now = new Date()) {
  const data = {};
  const counts = {};
  for (const store of STORES) {
    const rows = (await db.getAll(store)).sort(byId);
    data[store] = rows.map((r) => pick(r, FIELDS[store]));
    counts[store] = rows.length;
  }
  const meta = {};
  for (const key of META_KEYS) {
    const value = await db.getMeta(key);
    if (value !== undefined) meta[key] = value;
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    app: { name: 'CifrAI', databaseVersion: DB_VERSION },
    counts,
    data,
    meta,
  };
}

/** Texto JSON do backup (legível, com recuo). */
export function serializeBackup(backup) {
  return JSON.stringify(backup, null, 1);
}
