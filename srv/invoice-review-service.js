const cds = require('@sap/cds');
const fs   = require('fs');
const path = require('path');

// ------------------------------------------------------------------
// Mock bootstrap: hydrate attachment binary content from the sample PDFs
// bundled in srv/. LargeBinary cannot be seeded via plain CSV, so we stream the
// files into any Attachment whose Content is still empty. Idempotent.
// ------------------------------------------------------------------
cds.once('served', async () => {
  // No database at all when deployed (the review app reads S/4 directly there).
  // Connecting anyway fails at boot AND poisons cds.connect.to('db') for every
  // later caller — CAP caches the rejected promise together with this stack,
  // which is how a processEmail failure ends up reported from this line.
  if (!cds.env.requires?.db) return;

  try {
    const db = await cds.connect.to('db');
    const { Attachment } = db.entities('abeam.invoicereview');

    const pending = await db.run(
      SELECT.from(Attachment).columns('AttachmentUUID', 'FileName').where({ Content: null })
    );
    if (!pending.length) return;

    for (const att of pending) {
      const file = path.join(__dirname, att.FileName || 'Invoice.pdf');
      if (!fs.existsSync(file)) {
        console.warn(`[invoice-review] sample attachment not found: ${file}`);
        continue;
      }
      const buf = fs.readFileSync(file);
      await db.run(
        UPDATE(Attachment).set({ Content: buf, FileSize: buf.length }).where({ AttachmentUUID: att.AttachmentUUID })
      );
    }
    console.log(`[invoice-review] hydrated ${pending.length} mock attachment(s)`);
  } catch (err) {
    console.error('[invoice-review] attachment bootstrap failed:', err.message);
  }
});
