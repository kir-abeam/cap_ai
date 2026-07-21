const cds = require('@sap/cds');
const fs   = require('fs');
const path = require('path');

module.exports = class InvoiceReviewService extends cds.ApplicationService {

  async init() {
    const { Invoices, Emails } = this.entities;

    this.on('verify', Invoices, req => this._setStatus(req, 'V'));
    this.on('rejectInvoice', Invoices, req => this._setStatus(req, 'R'));

    // Hydrate the email-level rollup status from its child invoices.
    this.after('READ', Emails, rows => this._rollupEmails(rows));

    return super.init();
  }

  /**
   * Compute the rollup status virtual fields for each returned email. A to-many
   * aggregation can't be a plain CDS calculated element, so we do it here.
   * Criticality per status: Rejected 1 (red), Pending 2 (yellow), Verified 3
   * (green); the email shows the *most severe* (minimum) among its invoices.
   */
  async _rollupEmails(rows) {
    const emails = Array.isArray(rows) ? rows : [rows];
    const ids = emails.map(e => e && e.ID).filter(Boolean);
    if (!ids.length) return;

    const CRIT = { R: 1, P: 2, V: 3 };
    const invoices = await SELECT
      .from(this.entities.Invoices)
      .columns('email_ID', 'verificationStatus_code')
      .where({ email_ID: { in: ids } });

    const byEmail = {};
    for (const inv of invoices) {
      const g = (byEmail[inv.email_ID] ||= { total: 0, pending: 0, crit: 3 });
      g.total += 1;
      if (inv.verificationStatus_code === 'P') g.pending += 1;
      g.crit = Math.min(g.crit, CRIT[inv.verificationStatus_code] ?? 3);
    }

    for (const e of emails) {
      if (!e) continue;
      const g = byEmail[e.ID];
      if (!g || g.total === 0) {
        e.statusCriticality = 0;               // neutral: no invoices
        e.statusSummary = 'No invoices';
      } else {
        e.statusCriticality = g.crit;
        e.statusSummary = g.pending
          ? `${g.total} · ${g.pending} pending`
          : `${g.total} · done`;
      }
    }
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
