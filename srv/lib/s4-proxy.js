const cds = require('@sap/cds');

/**
 * S/4HANA delegation layer for InvoiceReviewService (App -> CAP -> S/4).
 *
 * The CAP service keeps its local (camelCase) contract and FE annotations; this
 * module translates between that contract and the remote S/4 service
 * (PascalCase names, UUID keys, draft-enabled). It works on the *parsed* query
 * (CQN) rather than raw OData, so filters / $orderby / $select / $expand are
 * remapped generically by element name.
 *
 * Activation is profile-gated: it only kicks in when the `ZUI_INVOICE_REVIEW_O4`
 * required service has credentials (i.e. the `s4` profile). Without them the
 * service keeps serving the local SQLite mock unchanged.
 *
 * NOTE: the write/draft path (verify, reject, header/line-item edits) drives
 * S/4's Email-rooted draft flow (Edit -> PATCH draft -> Activate). That flow
 * and the exact remote service path/destination need validation against the
 * live system; the read path is the primary tested surface.
 */

const REMOTE = 'ZUI_INVOICE_REVIEW_O4';

// --- per-entity element maps: local (CAP) element -> remote (S/4) element ----
// Navigation targets carry the remote *entity* name so nested expands can be
// remapped by switching the active map.
const MAPS = {
  Emails: {
    entity: 'Email',
    keys: ['ID'],
    fields: {
      ID: 'EmailUUID',
      emailSubject: 'EmailSubject',
      emailSentDate: 'EmailSentDate',
      emailSender: 'EmailSender',
      emailBodyHtml: 'EmailBodyHtml',
      summary: 'Summary',
      createdAt: 'CreatedAt',
      createdBy: 'CreatedBy',
      modifiedAt: 'LastChangedAt',
      modifiedBy: 'LastChangedBy'
    },
    // local nav name -> { to: S/4 nav name, target: local map key }
    navs: { invoices: { to: '_Invoice', target: 'Invoices' } }
  },
  Invoices: {
    entity: 'Invoice',
    keys: ['ID'],
    fields: {
      ID: 'InvoiceUUID',
      email_ID: 'EmailUUID',
      documentNumber: 'DocumentNumber',
      documentDate: 'DocumentDate',
      totalAmount: 'TotalAmount',
      currency: 'Currency',
      taxAmount: 'TaxAmount',
      vendorCode: 'VendorCode',
      vendorName: 'VendorName',
      vendorAccountNumber: 'VendorAccountNumber',
      verificationStatus_code: 'VerificationStatus',
      createdAt: 'CreatedAt',
      createdBy: 'CreatedBy',
      modifiedAt: 'LastChangedAt',
      modifiedBy: 'LastChangedBy'
    },
    navs: {
      email: { to: '_Email', target: 'Emails' },
      lineItems: { to: '_Item', target: 'InvoiceLineItems' },
      attachments: { to: '_Attachment', target: 'Attachments' }
    }
  },
  InvoiceLineItems: {
    entity: 'InvoiceItem',
    keys: ['ID'],
    fields: {
      ID: 'ItemUUID',
      invoice_ID: 'InvoiceUUID',
      amount: 'Amount',
      glAccount: 'GLAccount',
      costCenter: 'CostCenter',
      internalOrder: 'InternalOrder'
    },
    navs: { invoice: { to: '_Invoice', target: 'Invoices' } }
  },
  Attachments: {
    entity: 'Attachment',
    keys: ['ID'],
    fields: {
      ID: 'AttachmentUUID',
      invoice_ID: 'InvoiceUUID',
      fileName: 'FileName',
      mediaType: 'MediaType',
      content: 'Content',
      size: 'FileSize'
    },
    navs: { invoice: { to: '_Invoice', target: 'Invoices' } }
  }
};

// reverse lookups (S/4 element -> local element) per entity, built once
for (const m of Object.values(MAPS)) {
  m.rfields = Object.fromEntries(Object.entries(m.fields).map(([l, r]) => [r, l]));
  m.rnavs = Object.fromEntries(Object.entries(m.navs).map(([l, n]) => [n.to, { to: l, target: n.target }]));
}

/** local entity name for a CAP entity ref (strips the service prefix). */
function localName(ref) {
  const name = Array.isArray(ref) ? ref[0] : ref;
  return String(name).split('.').pop();
}

const l2r = (map, el) => map.fields[el] || el;         // local -> remote element
const r2l = (map, el) => map.rfields[el] || el;        // remote -> local element

// --------------------------------------------------------------------------
// CQN remapping: rewrite a parsed query targeting the local entity into one
// targeting the remote S/4 entity, translating every element reference.
// --------------------------------------------------------------------------

/** Deep-remap a CXN expression's `ref` element names using `map`. */
function remapExpr(node, map) {
  if (Array.isArray(node)) return node.map(n => remapExpr(n, map));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'ref' && Array.isArray(v)) {
        // simple flat refs on the current entity (e.g. ['emailSender'])
        out.ref = v.map(seg => (typeof seg === 'string' ? l2r(map, seg) : seg));
      } else {
        out[k] = remapExpr(v, map);
      }
    }
    return out;
  }
  return node;
}

/** Remap a SELECT columns list (handles renamed columns + nested expands). */
function remapColumns(columns, map) {
  if (!columns) return columns;
  const out = [];
  for (const col of columns) {
    if (col === '*' || col.val !== undefined || col.func) { out.push(col); continue; }
    if (col.ref) {
      const local = col.ref[0];
      const nav = map.navs[local];
      if (nav) {
        // Composition nav: keep only when expanded, remapping to the child map.
        if (col.expand) {
          const childMap = MAPS[nav.target];
          out.push({
            ref: [nav.to],
            expand: remapColumns(col.expand, childMap),
            ...(col.where ? { where: remapExpr(col.where, childMap) } : {}),
            ...(col.orderBy ? { orderBy: remapExpr(col.orderBy, childMap) } : {})
          });
        }
        continue;
      }
      // Drop anything that isn't a real S/4 field: virtual/calculated locals
      // (statusCriticality, statusSummary, isEditable) and code-list expands
      // (verificationStatus) don't exist remotely — S/4 would 502 with
      // "Property '...' not found". They're hydrated on our side instead.
      if (!(local in map.fields)) continue;
      out.push({ ...col, ref: [l2r(map, local)] });
      continue;
    }
    out.push(col);
  }
  return out;
}

/** Build a remote CQN SELECT from a local one. */
function remapSelect(cqn, map) {
  const s = cqn.SELECT;
  const out = { from: { ref: [`${REMOTE}.${map.entity}`] } };
  if (s.columns) {
    const cols = remapColumns(s.columns, map);
    if (cols && cols.length) out.columns = cols;   // else: let S/4 return all fields
  }
  if (s.where) out.where = remapExpr(s.where, map);
  if (s.orderBy) out.orderBy = remapExpr(s.orderBy, map);
  if (s.groupBy) out.groupBy = remapExpr(s.groupBy, map);
  if (s.limit) out.limit = s.limit;
  if (s.one) out.one = s.one;
  if (s.count) out.count = s.count;
  // Only active records: the remote is draft-enabled, so pin IsActiveEntity.
  out.where = andActive(out.where);
  return { SELECT: out };
}

/** AND an `IsActiveEntity = true` predicate onto an (optional) where clause. */
function andActive(where) {
  const active = [{ ref: ['IsActiveEntity'] }, '=', { val: true }];
  if (!where || !where.length) return active;
  return [{ xpr: where }, 'and', ...active];
}

// --------------------------------------------------------------------------
// Row mapping: remote rows -> local rows (recursively for expanded navs).
// --------------------------------------------------------------------------
function mapRowIn(map, row) {
  if (row == null) return row;
  const out = {};
  for (const [rk, rv] of Object.entries(row)) {
    const nav = map.rnavs[rk];
    if (nav) {
      const childMap = MAPS[nav.target];
      out[nav.to] = Array.isArray(rv) ? rv.map(r => mapRowIn(childMap, r)) : mapRowIn(childMap, rv);
      continue;
    }
    const lk = r2l(map, rk);
    out[lk] = rv;
  }
  // isEditable is a local calculated element (Pending only); derive it here
  // since delegated reads bypass CAP's calc engine.
  if (map.entity === 'Invoice' && 'verificationStatus_code' in out) {
    out.isEditable = out.verificationStatus_code === 'P';
  }
  return out;
}

/** Map a local key object to its remote equivalent (adds IsActiveEntity). */
function mapKeyOut(map, key) {
  const out = { IsActiveEntity: true };
  for (const [k, v] of Object.entries(key || {})) {
    if (k === 'IsActiveEntity') continue;
    out[l2r(map, k)] = v;
  }
  return out;
}

// --------------------------------------------------------------------------
// Public: register delegation handlers on the CAP service. No-op (returns
// false) unless the remote is configured with credentials (the `s4` profile).
// --------------------------------------------------------------------------
async function register(srv) {
  const cfg = cds.env.requires?.[REMOTE];
  // Delegate when the remote is wired up either inline (credentials) or via a
  // `cds bind` service binding (resolved from CF at runtime). Otherwise the
  // local SQLite mock stays in charge.
  if (!cfg?.credentials && !cfg?.binding) return false;

  const s4 = await cds.connect.to(REMOTE);
  const { Emails, Invoices, InvoiceLineItems, Attachments } = srv.entities;

  for (const entity of [Emails, Invoices, InvoiceLineItems, Attachments]) {
    const map = MAPS[localName(entity.name)];

    srv.on('READ', entity, async req => {
      const remoteQuery = remapSelect(req.query, map);
      const res = await s4.run(remoteQuery);
      const rows = Array.isArray(res) ? res.map(r => mapRowIn(map, r)) : mapRowIn(map, res);
      // preserve $count for FE growing lists
      if (res && res.$count !== undefined && Array.isArray(rows)) rows.$count = res.$count;
      return rows;
    });

    srv.on('UPDATE', entity, req => draftPatch(s4, map, req));
    srv.on('CREATE', entity, req => draftCreate(s4, map, req));
    srv.on('DELETE', entity, req => draftDelete(s4, map, req));
  }

  // Bound actions map to a VerificationStatus change on the invoice.
  srv.on('verify', Invoices, req => setStatus(s4, req, 'V'));
  srv.on('rejectInvoice', Invoices, req => setStatus(s4, req, 'R'));

  console.log(`[invoice-review] delegating to S/4 remote service '${REMOTE}'`);
  return true;
}

// --------------------------------------------------------------------------
// Write path via S/4's Email-rooted draft flow.
//   1. Edit the owning Email -> creates a draft tree
//   2. PATCH the target draft node (invoice / item / email)
//   3. Activate the Email draft
// The action calls use explicit OData paths so the draft dance is transparent.
// --------------------------------------------------------------------------

/** Resolve the owning Email UUID for any target entity's key. */
async function emailKeyFor(s4, map, key) {
  if (map.entity === 'Email') return key.ID;
  const rkey = mapKeyOut(map, key);
  const row = await s4.run(
    SELECT.one.from(`${REMOTE}.${map.entity}`).columns('EmailUUID').where(rkey)
  );
  return row?.EmailUUID;
}

async function editEmail(s4, emailUUID) {
  // POST .../Email(EmailUUID=...,IsActiveEntity=true)/<ns>.Edit
  return s4.send({
    method: 'POST',
    path: `Email(EmailUUID=${emailUUID},IsActiveEntity=true)/com.sap.gateway.srvd_a2x.zui_invoice_review_o4.v0001.Edit`,
    data: { PreserveChanges: false }
  });
}

async function activateEmail(s4, emailUUID) {
  return s4.send({
    method: 'POST',
    path: `Email(EmailUUID=${emailUUID},IsActiveEntity=false)/com.sap.gateway.srvd_a2x.zui_invoice_review_o4.v0001.Activate`,
    data: {}
  });
}

/**
 * Map local entity data to a remote write body.
 *   - `includeKey` keeps the entity's own key: the S/4 UUIDs are @Core.Immutable
 *     and listed in InsertRestrictions.RequiredProperties, so the CLIENT must
 *     supply them on create (they are no longer server-computed). FKs are always
 *     kept (also required on insert). On update we drop the key (it's in the URL
 *     and immutable) and FE only PATCHes changed business fields anyway.
 */
function writeBody(map, data, includeKey = false) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (map.navs[k] || k === 'IsActiveEntity') continue;
    if (!includeKey && map.keys.includes(k)) continue;
    out[l2r(map, k)] = v;
  }
  return out;
}

/** POST a child under a draft parent's composition nav; returns the new row. */
function postChild(s4, parentEntity, parentUUID, parentKeyName, nav, body) {
  return s4.send({
    method: 'POST',
    path: `${parentEntity}(${parentKeyName}=${parentUUID},IsActiveEntity=false)/${nav}`,
    data: body
  });
}

async function draftPatch(s4, map, req) {
  const key = req.params.at(-1);
  const emailUUID = await emailKeyFor(s4, map, key);
  await editEmail(s4, emailUUID);
  const draftKey = { ...mapKeyOut(map, key), IsActiveEntity: false };
  await s4.run(UPDATE(`${REMOTE}.${map.entity}`).set(writeBody(map, req.data)).where(draftKey));
  await activateEmail(s4, emailUUID);
  return SELECT.one.from(req.target).where(key);   // re-read via our READ handler
}

async function setStatus(s4, req, code) {
  const key = req.params.at(-1);
  const emailUUID = await emailKeyFor(s4, MAPS.Invoices, key);
  await editEmail(s4, emailUUID);
  const draftKey = { ...mapKeyOut(MAPS.Invoices, key), IsActiveEntity: false };
  await s4.run(UPDATE(`${REMOTE}.Invoice`).set({ VerificationStatus: code }).where(draftKey));
  await activateEmail(s4, emailUUID);
  return SELECT.one.from(req.target).where(key);
}

/** CREATE dispatcher: Email is a new draft root (deep); others are children. */
async function draftCreate(s4, map, req) {
  return map.entity === 'Email' ? createEmailDeep(s4, req) : createChild(s4, map, req);
}

/**
 * Create a full email tree in S/4: POST a new Email draft, POST its invoices to
 * the draft's _Invoice nav and each invoice's line items to _Item, then
 * activate. UUID keys are client-supplied (required + immutable on S/4), so we
 * use the local IDs and thread the owning EmailUUID / InvoiceUUID into children.
 */
async function createEmailDeep(s4, req) {
  const data = req.data;
  const emailUUID = data.ID;
  await s4.run(INSERT.into(`${REMOTE}.Email`).entries(writeBody(MAPS.Emails, data, true)));

  for (const inv of data.invoices || []) {
    await postChild(s4, 'Email', emailUUID, 'EmailUUID', '_Invoice',
      { ...writeBody(MAPS.Invoices, inv, true), EmailUUID: emailUUID });
    for (const item of inv.lineItems || []) {
      await postChild(s4, 'Invoice', inv.ID, 'InvoiceUUID', '_Item',
        { ...writeBody(MAPS.InvoiceLineItems, item, true), InvoiceUUID: inv.ID, EmailUUID: emailUUID });
    }
  }

  await activateEmail(s4, emailUUID);
  return SELECT.one.from(req.target).where({ ID: emailUUID });
}

/** Create a single child (e.g. a line item) under an existing active email. */
async function createChild(s4, map, req) {
  const NAV = {
    Invoice:     { parent: 'Email',   parentKey: 'EmailUUID',   fk: 'email_ID',   nav: '_Invoice' },
    InvoiceItem: { parent: 'Invoice', parentKey: 'InvoiceUUID', fk: 'invoice_ID', nav: '_Item' },
    Attachment:  { parent: 'Invoice', parentKey: 'InvoiceUUID', fk: 'invoice_ID', nav: '_Attachment' }
  }[map.entity];
  const parentUUID = req.data[NAV.fk];
  // Owning email: for an Invoice the parent IS the email; otherwise resolve it.
  const emailUUID = NAV.parent === 'Email'
    ? parentUUID
    : await emailKeyFor(s4, MAPS.Invoices, { ID: parentUUID });
  await editEmail(s4, emailUUID);
  // S/4 requires the key + owning UUIDs on insert (RequiredProperties).
  const body = { ...writeBody(map, req.data, true), EmailUUID: emailUUID };
  if (NAV.parentKey === 'InvoiceUUID') body.InvoiceUUID = parentUUID;
  const created = await postChild(s4, NAV.parent, parentUUID, NAV.parentKey, NAV.nav, body);
  await activateEmail(s4, emailUUID);
  return mapRowIn(map, created);
}

async function draftDelete(s4, map, req) {
  const key = req.params.at(-1);
  const emailUUID = await emailKeyFor(s4, map, key);
  await editEmail(s4, emailUUID);
  await s4.run(DELETE.from(`${REMOTE}.${map.entity}`).where({ ...mapKeyOut(map, key), IsActiveEntity: false }));
  await activateEmail(s4, emailUUID);
}

module.exports = { register, MAPS, remapSelect, mapRowIn };
