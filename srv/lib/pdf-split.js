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

/**
 * A PDF pdf-lib cannot open, or must not rewrite. Typed so the pipeline can
 * tell it apart from a genuine bug and fall back to "process the file whole"
 * instead of losing the attachment.
 */
class UnsplittablePdfError extends Error {
  constructor(message, { encrypted = false } = {}) {
    super(message);
    this.name = 'UnsplittablePdfError';
    this.encrypted = encrypted;
  }
}

/**
 * Does the file declare `/Encrypt`?
 *
 * pdf-lib implements **no decryption whatsoever** — `ignoreEncryption: true`
 * only suppresses its "document is encrypted" guard, after which it parses the
 * still-ciphertext object streams as if they were PDF syntax. That produces
 * `Trying to parse invalid object` / `Invalid object ref` noise and then a
 * baffling `Expected instance of PDFDict, but got instance of undefined` from
 * deep inside PDFCatalog — an error that says nothing about the real cause.
 *
 * Even when such a document happens to parse, copying its encrypted streams
 * into a new unencrypted PDF yields an attachment that will not render. So an
 * encrypted PDF is never split: the original bytes are kept intact instead,
 * which every viewer (and the LLM) reads correctly.
 *
 * Content streams are compressed, so a plaintext `/Encrypt` is a reliable
 * signal rather than an accidental match inside page content.
 */
function isEncrypted(base64) {
  return Buffer.from(base64, 'base64').includes('/Encrypt');
}

/** Load a base64 PDF, or explain why it cannot be split. */
async function _load(base64) {
  if (isEncrypted(base64)) {
    throw new UnsplittablePdfError(
      'the PDF is encrypted and pdf-lib cannot decrypt it', { encrypted: true });
  }

  try {
    return await PDFDocument.load(Buffer.from(base64, 'base64'));
  } catch (error) {
    throw new UnsplittablePdfError(`pdf-lib could not parse the PDF: ${error.message}`);
  }
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
 * Throws `UnsplittablePdfError` when the document cannot be opened or rewritten
 * (encrypted, or malformed beyond pdf-lib's tolerance).
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

module.exports = { splitPdf, pageCount, isEncrypted, UnsplittablePdfError };
