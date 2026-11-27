// Leitura de PDF com PDF.js: transforma o arquivo em linhas de texto.
// Importante: o PDF.js só lê TEXTO que existe no arquivo. PDFs escaneados (que são
// apenas imagens) não têm texto, então avisamos o usuário em vez de tentar adivinhar.

const PDFJS_URL = new URL('../../lib/pdfjs/pdf.min.mjs', import.meta.url).href;
const WORKER_URL = new URL('../../lib/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

/** Erro com um código para a tela mostrar a mensagem certa. */
export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/**
 * Agrupa pedaços de texto do PDF em linhas, usando a posição na página.
 * Cada item: { str, x, y }. Itens com y parecido ficam na mesma linha, ordenados da esquerda p/ direita.
 * (Função pura, testável sem PDF.)
 */
export function groupItemsIntoLines(items, tolerance = 3) {
  const sorted = items
    .filter((i) => i.str && i.str.trim() !== '')
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  for (const item of sorted) {
    const row = rows.find((r) => Math.abs(r.y - item.y) <= tolerance);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) =>
      row.items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str.trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
}

/**
 * Lê o PDF e devolve { pageCount, lines: [{ page, text }], charCount }.
 * @param {File|Blob} file
 * @param {(page:number,total:number)=>void} [onProgress]
 */
export async function extractLines(file, onProgress = () => {}) {
  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new ImportError('senha', 'Este PDF está protegido por senha. Remova a proteção e tente de novo.');
    }
    throw new ImportError('invalido', 'Não consegui abrir este arquivo como PDF. Ele pode estar corrompido.');
  }

  const lines = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    onProgress(pageNumber, doc.numPages);
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items
      .filter((i) => typeof i.str === 'string')
      .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] }));
    for (const text of groupItemsIntoLines(items)) lines.push({ page: pageNumber, text });
  }
  const pageCount = doc.numPages;
  await doc.destroy();

  const charCount = lines.reduce((sum, l) => sum + l.text.replace(/\s/g, '').length, 0);
  if (charCount < 20) {
    throw new ImportError(
      'sem_texto',
      'Este PDF não tem texto que eu consiga ler. Provavelmente é um extrato escaneado (foto ou imagem). ' +
      'O CifrAI ainda não faz reconhecimento de imagem (OCR). Baixe o extrato em PDF direto do aplicativo ou site do banco.'
    );
  }
  return { pageCount, lines, charCount };
}
