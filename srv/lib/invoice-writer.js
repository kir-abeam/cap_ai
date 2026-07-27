const cds = require('@sap/cds');

/**
 * Persists one processed email (header + its invoices, line items and split-PDF
 * attachments) into the invoice-review backend.
 *
 * Two backends, same field names (db/schema.cds mirrors ZUI_INVOICE_REVIEW_O4 1:1):
 *   - 'local' : straight INSERTs into the SQLite tables behind InvoiceReviewService
 *   - 's4'    : the Email-rooted draft flow on the real S/4 service
 * The target is picked from the runtime config, so `cds watch` writes locally and
 * `npm run s4` writes to S/4 without a code change.
 */

const REMOTE = 'ZUI_INVOICE_REVIEW_O4';
const S4_NS = 'com.sap.gateway.srvd_a2x.zui_invoice_review_o4.v0001';

// -------------------------------------------------------------------------
// Value coercion. The extraction prompt yields strings (and "" for "not
// found"), while the target columns are typed and length-bounded — an
// over-long string is a hard error on S/4, so clamp here rather than there.
// -------------------------------------------------------------------------

/** Trim to `max` chars; empty/blank -> null. */
function str(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return max && s.length > max ? s.slice(0, max) : s;
}

/** "RM 1,234.50" / "1234.5" -> 1234.5 ; anything unparseable -> null. */
function num(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Normalize to an Edm.Date 'YYYY-MM-DD'; unparseable -> null. */
function isoDate(value) {
  const s = str(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Normalize to an Edm.DateTimeOffset string; unparseable/missing -> now. */
function timestamp(value) {
  if (value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Which backend to write to. S/4 as soon as its binding/credentials resolve
 * (i.e. `cds watch --profile s4`), local otherwise — the same test srv/server.js
 * uses to decide whether to mount the dev proxy. INVOICE_WRITE_TARGET overrides.
 */
function writeTarget() {
  const override = process.env.INVOICE_WRITE_TARGET;
  if (override) return override;
  const cfg = cds.env.requires?.[REMOTE];
  return (cfg?.credentials || cfg?.binding) ? 's4' : 'local';
}

// -------------------------------------------------------------------------
// Mapping: extraction shape (camelCase, DocumentProcessingService.cds) ->
// persisted shape (PascalCase, shared by db/schema.cds and S/4).
// -------------------------------------------------------------------------

function mapEmail(emailUUID, email, summaryHtml) {
  return {
    EmailUUID: emailUUID,
    EmailSubject: str(email?.subject, 255),
    EmailSentDate: timestamp(email?.sentDate),
    EmailSender: str(email?.sender, 241),
    // Already base64 on the wire and stored base64 — the Fiori formatters decode
    // it for rendering, so it must NOT be decoded here.
    EmailBodyHtml: email?.content ?? null,
    // The LLM returns plain HTML; the column follows the same base64 convention
    // as EmailBodyHtml (see AISummaryFormatter.js).
    Summary: summaryHtml ? Buffer.from(summaryHtml, 'utf8').toString('base64') : null
  };
}

function mapInvoice(invoiceUUID, emailUUID, header) {
  return {
    InvoiceUUID: invoiceUUID,
    EmailUUID: emailUUID,
    DocumentNumber: str(header?.invoiceNumber, 60),
    DocumentDate: isoDate(header?.invoiceDate),
    TotalAmount: num(header?.totalAmount),
    Currency: str(header?.currency, 3)?.toUpperCase() ?? null,
    TaxAmount: num(header?.taxAmount),
    VendorCode: str(header?.payeeCode, 40),
    VendorName: str(header?.payeeName, 255),
    VendorAccountNumber: str(header?.payeeAccountNumber, 60),
    VerificationStatus: 'P'          // everything lands in the review queue as Pending
  };
}

function mapItem(itemUUID, invoiceUUID, emailUUID, item) {
  return {
    ItemUUID: itemUUID,
    InvoiceUUID: invoiceUUID,
    EmailUUID: emailUUID,            // S/4 carries the owning email on the item too
    Amount: num(item?.amount),
    GLAccount: str(item?.glAccount, 10),
    CostCenter: str(item?.costCenter, 10),
    InternalOrder: str(item?.internalOrder, 12)
  };
}

function mapAttachment(attachmentUUID, invoiceUUID, emailUUID, attachment) {
  const bytes = Buffer.from(attachment.content, 'base64');
  return {
    AttachmentUUID: attachmentUUID,
    InvoiceUUID: invoiceUUID,
    EmailUUID: emailUUID,
    FileName: str(attachment.fileName, 255),
    MediaType: 'application/pdf',
    FileSize: bytes.length,
    _base64: attachment.content,     // S/4 wants base64 (Edm.Binary)
    _bytes: bytes                    // local wants a Buffer (LargeBinary)
  };
}

/**
 * Build the full record graph with keys assigned up front, so both write paths
 * return the same UUIDs to the caller.
 *
 * @param {object}   email        the processEmail `email` input
 * @param {string}   summary      AI summary, plain HTML
 * @param {object[]} invoices     [{ header, attachment: { fileName, content(base64) } }]
 */
function buildGraph({ email, summary, invoices }) {
  const emailUUID = cds.utils.uuid();
  const emailRow = mapEmail(emailUUID, email, summary);

  const rows = (invoices || []).map(inv => {
    const invoiceUUID = cds.utils.uuid();
    return {
      invoice: mapInvoice(invoiceUUID, emailUUID, inv.header),
      items: (inv.header?.lineItems || []).map(item =>
        mapItem(cds.utils.uuid(), invoiceUUID, emailUUID, item)),
      attachment: inv.attachment
        ? mapAttachment(cds.utils.uuid(), invoiceUUID, emailUUID, inv.attachment)
        : null
    };
  });

  return { emailUUID, emailRow, rows };
}

// -------------------------------------------------------------------------
// Local path — write straight to the tables. Draft is a UI concern; the rows
// we insert are the active ones, exactly like the CSV seed data.
// -------------------------------------------------------------------------

async function _writeLocal({ emailRow, rows }) {
  // A deployment with neither an S/4 binding nor a database lands here and CAP
  // only says "Didn't find a configuration for 'cds.requires.db'", which does
  // not point at the actual mistake. Say what is missing instead.
  if (!cds.env.requires?.db) {
    throw new Error(
      "No write target available: the 'local' backend needs cds.requires.db, and none is configured. " +
      `In Cloud Foundry, bind the S/4 service (${REMOTE}) so the 's4' target is used — see the ` +
      'ai_cap-invoice-review resource in mta.yaml. To force a target explicitly, set INVOICE_WRITE_TARGET=s4.');
  }

  const db = await cds.connect.to('db');
  const { Email, Invoice, InvoiceItem, Attachment } = db.entities('abeam.invoicereview');

  await db.tx(async tx => {
    await tx.run(INSERT.into(Email).entries(emailRow));

    for (const row of rows) {
      await tx.run(INSERT.into(Invoice).entries(row.invoice));
      if (row.items.length) await tx.run(INSERT.into(InvoiceItem).entries(row.items));
      if (row.attachment) {
        const { _base64, _bytes, ...att } = row.attachment;
        await tx.run(INSERT.into(Attachment).entries({ ...att, Content: _bytes }));
      }
    }
  });
}

// -------------------------------------------------------------------------
// S/4 path — the draft-enabled RAP service takes no deep insert, so the graph
// is created node by node inside one Email draft and then activated.
// -------------------------------------------------------------------------

/** OData V4 key predicate for a draft node, e.g. Email(EmailUUID=<g>,IsActiveEntity=false). */
function draftKey(entity, keyName, uuid) {
  return `${entity}(${keyName}=${uuid},IsActiveEntity=false)`;
}

/**
 * Dig the human-readable reason out of an S/4 error. Gateway answers with an
 * OData error document whose format follows the request's Accept header; when
 * that is XML, CAP's remote client fails to parse it and reports only
 * "Error while parsing an XML stream", hiding the actual message. Both shapes
 * are handled here so a failure says what S/4 objected to.
 */
function s4Reason(err) {
  const response = err?.reason?.response ?? err?.response;
  const body = response?.body ?? response?.data;
  if (!body) return err.message;

  // JSON: { error: { message: "..." | { value: "..." }, details: [...] } }
  const error = body.error ?? body;
  let message = error?.message?.value ?? error?.message;
  if (message && typeof message === 'string') {
    const details = (error.details || []).map(d => d.message).filter(Boolean);
    return details.length ? `${message} (${details.join('; ')})` : message;
  }

  // XML: <error><message>...</message></error>
  if (typeof body === 'string') {
    const m = body.match(/<message[^>]*>([\s\S]*?)<\/message>/i);
    if (m) return m[1].trim();
    return body.slice(0, 500);
  }

  return err.message;
}

/**
 * Drop null/undefined properties.
 *
 * Almost every property of the S/4 service is `Nullable="false"` — ABAP fields
 * have initial values, not nulls — and Gateway rejects an explicit null with
 * "Property '<name>' at offset '<n>' has invalid value 'null'". Omitting the
 * property instead lets RAP apply the initial value ('' / 0), which is what
 * "not found" means here. The local backend keeps the nulls: it is a real CDS
 * model where a missing value and an empty string are worth distinguishing.
 */
function compact(data) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== null && value !== undefined));
}

/**
 * One request to S/4, with the JSON content negotiation made explicit.
 *
 * `content-type` is set by hand because CAP's remote client only adds it when
 * `requestConfig.data` is a plain object; without it Gateway parses the body as
 * XML/Atom and answers 400 "Error while parsing an XML stream". `accept` keeps
 * error bodies in the JSON shape the client reads, so failures carry S/4's own
 * message. Caller headers are merged last by CAP, so both take effect.
 */
async function _send(srv, method, path, data) {
  try {
    return await srv.send({
      method,
      path,
      data: compact(data),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json'
      }
    });
  } catch (err) {
    const status = err?.reason?.response?.status ?? err.statusCode ?? '';
    const error = new Error(`S/4 ${method} ${path} failed${status ? ` (${status})` : ''}: ${s4Reason(err)}`);
    error.cause = err;
    throw error;
  }
}

/**
 * RAP may assign its own key instead of honouring the one we sent (managed /
 * early numbering). Always continue from the key S/4 echoes back, so the child
 * paths point at the node that actually exists.
 */
function keyFrom(response, keyName, fallback) {
  return response?.[keyName] ?? fallback;
}

async function _writeS4({ emailUUID, emailRow, rows }) {
  const srv = await cds.connect.to(REMOTE);

  // POST to the entity set creates the draft instance (IsActiveEntity=false).
  const createdEmail = await _send(srv, 'POST', 'Email', emailRow);
  const realEmailUUID = keyFrom(createdEmail, 'EmailUUID', emailUUID);
  const emailPath = draftKey('Email', 'EmailUUID', realEmailUUID);

  try {
    for (const row of rows) {
      const createdInvoice = await _send(srv, 'POST', `${emailPath}/_Invoice`,
        { ...row.invoice, EmailUUID: realEmailUUID });
      const invoiceUUID = keyFrom(createdInvoice, 'InvoiceUUID', row.invoice.InvoiceUUID);
      row.invoice.InvoiceUUID = invoiceUUID;                  // reported back to the caller
      const invoicePath = draftKey('Invoice', 'InvoiceUUID', invoiceUUID);

      for (const item of row.items) {
        await _send(srv, 'POST', `${invoicePath}/_Item`,
          { ...item, InvoiceUUID: invoiceUUID, EmailUUID: realEmailUUID });
      }

      if (row.attachment) {
        const { _base64, _bytes, ...att } = row.attachment;
        await _send(srv, 'POST', `${invoicePath}/_Attachment`, {
          ...att,
          InvoiceUUID: invoiceUUID,
          EmailUUID: realEmailUUID,
          Content: _base64                                    // Edm.Binary -> base64 string
        });
      }
    }

    await _send(srv, 'POST', `${emailPath}/${S4_NS}.Activate`, {});
  } catch (err) {
    // Don't leave a half-built draft locking the email in the review app.
    try {
      await _send(srv, 'POST', `${emailPath}/${S4_NS}.Discard`, {});
    } catch (discardErr) {
      console.error('[invoice-writer] discarding the failed draft also failed:', discardErr.message);
    }
    throw err;
  }

  return realEmailUUID;
}

/**
 * Create the email and its invoices in whichever backend is configured.
 * @returns {Promise<{emailUUID:string, target:string, invoiceUUIDs:string[]}>}
 */
async function createEmailWithInvoices({ email, summary, invoices }) {
  const graph = buildGraph({ email, summary, invoices });
  const target = writeTarget();

  // S/4 may hand back its own keys; _writeS4 returns the ones that were used.
  const emailUUID = target === 's4'
    ? await _writeS4(graph)
    : (await _writeLocal(graph), graph.emailUUID);

  return {
    emailUUID,
    target,
    invoiceUUIDs: graph.rows.map(r => r.invoice.InvoiceUUID)
  };
}

module.exports = { createEmailWithInvoices, writeTarget, str, num, isoDate, timestamp };
