// Salvar e abrir o ARQUIVO de backup, sempre no seu computador.
// Nada é enviado para a internet: não há rede neste módulo (um teste automático confere isso).
import { serializeBackup } from './backupExport.js';
import { parseBackupText, MAX_FILE_BYTES } from './backupValidate.js';
import { setSetting } from '../storage.js';

const pad = (n) => String(n).padStart(2, '0');

export function backupFileName(now = new Date()) {
  return `cifrai-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

export function createBackupBlob(backup) {
  return new Blob([serializeBackup(backup)], { type: 'application/json' });
}

/**
 * Salva o backup. Em navegadores que permitem (Chrome, Edge), abre a janela "Salvar como" para você ESCOLHER
 * a pasta. Nos demais, faz o download normal (o navegador pode perguntar onde salvar, conforme a configuração).
 * @returns {{ saved:boolean, method:'picker'|'download', cancelled?:boolean, fileName:string }}
 */
export async function saveBackupFile(backup, { now = new Date(), picker = globalThis.showSaveFilePicker } = {}) {
  const fileName = backupFileName(now);
  const blob = createBackupBlob(backup);

  if (typeof picker === 'function') {
    try {
      const handle = await picker.call(globalThis, { suggestedName: fileName, types: [{ description: 'Backup do CifrAI (JSON)', accept: { 'application/json': ['.json'] } }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      setSetting('lastBackup', now.toISOString());
      return { saved: true, method: 'picker', fileName: handle.name || fileName };
    } catch (error) {
      if (error?.name === 'AbortError') return { saved: false, cancelled: true, method: 'picker', fileName };
      // se o seletor falhar por outro motivo, cai no download comum
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setSetting('lastBackup', now.toISOString());
  return { saved: true, method: 'download', fileName };
}

/** Lê um arquivo escolhido pelo usuário e valida (sem restaurar nada). */
export async function readBackupFile(file) {
  if (!file) return { ok: false, incompatible: false, errors: ['Nenhum arquivo escolhido.'], warnings: [] };
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, incompatible: false, errors: [`O arquivo é grande demais (${Math.round(file.size / 1048576)} MB; o limite é ${MAX_FILE_BYTES / 1048576} MB).`], warnings: [] };
  }
  let text;
  try { text = await file.text(); } catch { return { ok: false, incompatible: false, errors: ['Não consegui ler o arquivo.'], warnings: [] }; }
  return parseBackupText(text);
}
