const { PDFDocument } = require('pdf-lib');

/**
 * PDF page splitting for the processEmail pipeline. getInvoicePages tells us
 * which page ranges of a (possibly multi-invoice) attachment hold one invoice
 * each; this turns those ranges into standalone one-invoice PDFs that can be
 * fed to extractInvoice and stored as Attachment.Content.
 *
 * No CAP coupling on purpose — plain base64 in, plain base64 out, so it is
 * testable with a bare node script.
 */

/** Load a base64 PDF. `ignoreEncryption` so owner-password-protected (but readable) invoices still split. */
async function _load(base64) {
  return PDFDocument.load(Buffer.from(base64, 'base64'), { ignoreEncryption: true });
}

/** Number of pages in a base64 PDF. Used to fall back to "the whole document is one invoice". */
async function pageCount(base64) {
  return (await _load(base64)).getPageCount();
}

/**
 * Split a base64 PDF into one base64 PDF per page range.
 *
 * Ranges are 1-based and inclusive — the contract the getInvoicePages prompt
 * states. The model is not reliable about bounds, so ranges are clamped to the
 * document and anything still degenerate (start > end, non-numeric) is skipped
 * rather than throwing: one bad range must not lose the other invoices.
 *
 * @param {string} base64 source PDF
 * @param {{startPage:number,endPage:number}[]} ranges
 * @returns {Promise<{startPage:number,endPage:number,content:string}[]>} content is base64
 */
async function splitPdf(base64, ranges) {
  const src = await _load(base64);
  const total = src.getPageCount();
  const out = [];

  for (const range of ranges || []) {
    const rawStart = Number(range?.startPage);
    // A range with only a startPage means a single page.
    const rawEnd = Number(range?.endPage ?? range?.startPage);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;

    const start = Math.max(1, Math.trunc(rawStart));
    const end = Math.min(total, Math.trunc(rawEnd));
    if (end < start || start > total) continue;

    const doc = await PDFDocument.create();
    const indices = [];
    for (let p = start; p <= end; p++) indices.push(p - 1);   // pdf-lib is 0-based
    const pages = await doc.copyPages(src, indices);
    for (const page of pages) doc.addPage(page);

    out.push({
      startPage: start,
      endPage: end,
      content: Buffer.from(await doc.save()).toString('base64')
    });
  }

  return out;
}

module.exports = { splitPdf, pageCount };
