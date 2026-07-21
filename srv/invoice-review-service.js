const cds = require('@sap/cds');
const fs   = require('fs');
const path = require('path');

module.exports = class InvoiceReviewService extends cds.ApplicationService {

  async init() {
    const { Invoices } = this.entities;

    this.on('verify', Invoices, req => this._setStatus(req, 'V'));
    this.on('rejectInvoice', Invoices, req => this._setStatus(req, 'R'));

    return super.init();
  }

  /** Bound action handler: set the verification status of the active record. */
  async _setStatus(req, code) {
    // For a bound action the key of the active instance is the last params entry.
    const key = req.params.at(-1);
    await UPDATE(this.entities.Invoices).set({ verificationStatus_code: code }).where(key);
    return SELECT.one.from(this.entities.Invoices).where(key);
  }
};

// ------------------------------------------------------------------
// Mock bootstrap: hydrate attachment binary content from the sample PDFs
// bundled in srv/. LargeBinary cannot be seeded via plain CSV, so we stream
// the files into any Attachment whose content is still empty. Idempotent.
// ------------------------------------------------------------------
cds.once('served', async () => {
  try {
    const db = await cds.connect.to('db');
    const { Attachments } = db.entities('abeam.invoicereview');

    const pending = await db.run(
      SELECT.from(Attachments).columns('ID', 'fileName').where({ content: null })
    );
    if (!pending.length) return;

    for (const att of pending) {
      const file = path.join(__dirname, att.fileName || 'Invoice.pdf');
      if (!fs.existsSync(file)) {
        console.warn(`[invoice-review] sample attachment not found: ${file}`);
        continue;
      }
      const buf = fs.readFileSync(file);
      await db.run(
        UPDATE(Attachments).set({ content: buf, size: buf.length }).where({ ID: att.ID })
      );
    }
    console.log(`[invoice-review] hydrated ${pending.length} mock attachment(s)`);
  } catch (err) {
    console.error('[invoice-review] attachment bootstrap failed:', err.message);
  }
});
