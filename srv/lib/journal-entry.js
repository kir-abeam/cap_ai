const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

/**
 * Posts a verified non-PO invoice to S/4 as an FI vendor invoice (FB60
 * equivalent, document type KR) through the standard SOAP service
 * JournalEntryCreateRequestConfirmation_In ("Journal Entry – Post (Synchronous)").
 *
 * No CAP coupling beyond reading the endpoint config: the envelope builder and
 * the response parser are pure functions over the persisted (PascalCase)
 * Invoice / InvoiceItem shape shared by db/schema.cds and ZUI_INVOICE_REVIEW_O4.
 *
 * Endpoint: cds.requires.S4_JOURNAL_ENTRY — a subaccount destination when
 * deployed, a CF user-provided service under the `s4` profile. Its URL is the
 * full SOAMANAGER endpoint (…/sap/bc/srt/xip/sap/journalentrycreaterequestconfi/<client>/<service>/<binding>).
 */

const REMOTE = 'S4_JOURNAL_ENTRY';
const SFIN_NS = 'http://sap.com/xi/SAPSCORE/SFIN';

// -------------------------------------------------------------------------
// Envelope
// -------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** <Tag>value</Tag>, or nothing at all when the value is empty — S/4 treats an empty element as "set to blank". */
function el(tag, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<${tag}>${esc(value)}</${tag}>`;
}

function amount(tag, value, currency) {
  return `<${tag} currencyCode="${esc(currency)}">${Number(value).toFixed(2)}</${tag}>`;
}

/**
 * The SOAP proxy applies no ALPHA conversion, so purely numeric keys must
 * arrive zero-padded ("100234" -> "0000100234"); anything alphanumeric is
 * passed through as typed.
 */
function alpha(value, length) {
  const s = String(value ?? '').trim();
  return /^\d+$/.test(s) && s.length < length ? s.padStart(length, '0') : s;
}

function clip(value, max) {
  const s = String(value ?? '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * Split the invoice's tax across its line items, proportionally to each item's
 * amount; the last item absorbs the rounding so the net lines sum exactly.
 * Line items carry GROSS amounts (sum(items) == TotalAmount, see the extraction
 * prompt), so each G/L line posts gross minus its tax share.
 */
function netAmounts(items, gross, tax) {
  if (!tax) return items.map(i => Number(i.Amount));
  let allocated = 0;
  return items.map((item, idx) => {
    const share = idx === items.length - 1
      ? round2(tax - allocated)
      : round2(tax * Number(item.Amount) / gross);
    allocated = round2(allocated + share);
    return round2(Number(item.Amount) - share);
  });
}

/**
 * Build the JournalEntryBulkCreateRequest envelope for one invoice.
 *
 * Vendor line credits TotalAmount; one G/L line per InvoiceItem debits it (net
 * of tax when a tax code is known); one ProductTaxItem carries TaxAmount.
 * Without a tax code the G/L lines post gross and a warning is returned — the
 * API does not calculate tax itself, so there is nothing to derive it from.
 *
 * @returns {{ xml: string, warnings: string[] }}
 */
function buildEnvelope({ invoice, items, companyCode, postingDate, documentType = 'KR', taxCode, createdBy, messageId }) {
  const warnings = [];
  const currency = invoice.Currency;
  const gross = Number(invoice.TotalAmount);
  const taxAmount = Number(invoice.TaxAmount) || 0;
  const tax = taxCode && taxAmount > 0 ? taxAmount : 0;
  if (taxAmount > 0 && !taxCode) {
    warnings.push(`No tax code: tax ${taxAmount.toFixed(2)} ${currency} was posted inside the G/L lines (gross).`);
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const id = (messageId || cds.utils.uuid()).replace(/-/g, '');
  const net = netAmounts(items, gross, tax);

  const glItems = items.map((item, idx) => `
        <Item>
          <ReferenceDocumentItem>${idx + 1}</ReferenceDocumentItem>
          ${el('GLAccount', alpha(item.GLAccount, 10))}
          ${amount('AmountInTransactionCurrency', net[idx], currency)}
          <DebitCreditCode>S</DebitCreditCode>
          ${el('DocumentItemText', clip(item.ItemText || invoice.VendorName, 50))}
          ${tax ? `<Tax><TaxCode>${esc(item.TaxCode || taxCode)}</TaxCode></Tax>` : ''}
          ${item.CostCenter || item.InternalOrder ? `<AccountAssignment>
            ${el('CostCenter', alpha(item.CostCenter, 10))}
            ${el('OrderID', alpha(item.InternalOrder, 12))}
          </AccountAssignment>` : ''}
        </Item>`).join('');

  const creditorItem = `
        <CreditorItem>
          <ReferenceDocumentItem>${items.length + 1}</ReferenceDocumentItem>
          <Creditor>${esc(alpha(invoice.VendorCode, 10))}</Creditor>
          ${amount('AmountInTransactionCurrency', -gross, currency)}
          <DebitCreditCode>H</DebitCreditCode>
          ${el('DocumentItemText', clip(invoice.DocumentNumber, 50))}
        </CreditorItem>`;

  const taxItem = tax ? `
        <ProductTaxItem>
          <TaxCode>${esc(taxCode)}</TaxCode>
          ${amount('AmountInTransactionCurrency', tax, currency)}
          ${amount('TaxBaseAmountInTransCrcy', round2(gross - tax), currency)}
          <DebitCreditCode>S</DebitCreditCode>
        </ProductTaxItem>` : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sfin="${SFIN_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <sfin:JournalEntryBulkCreateRequest>
      <MessageHeader>
        <ID>${id}</ID>
        <CreationDateTime>${now}</CreationDateTime>
      </MessageHeader>
      <JournalEntryCreateRequest>
        <MessageHeader>
          <ID>${id}</ID>
          <CreationDateTime>${now}</CreationDateTime>
        </MessageHeader>
        <JournalEntry>
          <OriginalReferenceDocumentType>BKPFF</OriginalReferenceDocumentType>
          <BusinessTransactionType>RFBU</BusinessTransactionType>
          <AccountingDocumentType>${esc(documentType)}</AccountingDocumentType>
          ${el('DocumentReferenceID', clip(invoice.DocumentNumber, 16))}
          ${el('DocumentHeaderText', clip(invoice.VendorName, 25))}
          ${el('CreatedByUser', clip(createdBy, 12))}
          <CompanyCode>${esc(companyCode)}</CompanyCode>
          <DocumentDate>${esc(invoice.DocumentDate || postingDate)}</DocumentDate>
          <PostingDate>${esc(postingDate)}</PostingDate>${glItems}${creditorItem}${taxItem}
        </JournalEntry>
      </JournalEntryCreateRequest>
    </sfin:JournalEntryBulkCreateRequest>
  </soapenv:Body>
</soapenv:Envelope>`;

  return { xml, warnings };
}

// -------------------------------------------------------------------------
// Response. The confirmation is small and fixed-shape, so a few anchored
// regexes read it without pulling in an XML parser. Namespace prefixes vary
// (n0:, ns1:, none), hence the optional `\w+:` in every tag.
// -------------------------------------------------------------------------

function tag(xml, name) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? m[1].trim() : '';
}

function tags(xml, name) {
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g');
  return [...xml.matchAll(re)].map(m => m[1]);
}

function unesc(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * @returns {{ ok: boolean, accountingDocument: string, fiscalYear: string,
 *             companyCode: string, messages: {severity:string, text:string}[] }}
 * A failed posting still answers HTTP 200: the document number comes back as
 * 0000000000 and the reason is in the Log items (severity 3 = error).
 */
function parseResponse(xml) {
  const fault = tag(xml, 'faultstring');
  if (fault) {
    return { ok: false, accountingDocument: '', fiscalYear: '', companyCode: '',
      messages: [{ severity: 'error', text: unesc(fault) }] };
  }

  // Exactly one set of document keys per invoice (we send one JournalEntry).
  const accountingDocument = tag(xml, 'AccountingDocument');
  const fiscalYear = tag(xml, 'FiscalYear');
  const companyCode = tag(xml, 'CompanyCode');

  const severity = { 1: 'info', 2: 'warning', 3: 'error', 4: 'error' };
  const seen = new Set();
  const messages = [];
  for (const item of tags(xml, 'Item')) {
    const text = unesc(tag(item, 'Note'));
    if (!text || seen.has(text)) continue;     // the bulk + single logs repeat each other
    seen.add(text);
    messages.push({ severity: severity[tag(item, 'SeverityCode')] || 'info', text });
  }

  const ok = /^\d+$/.test(accountingDocument) && !/^0+$/.test(accountingDocument);
  return { ok, accountingDocument: ok ? accountingDocument : '', fiscalYear, companyCode, messages };
}

// -------------------------------------------------------------------------
// Transport
// -------------------------------------------------------------------------

function isConfigured() {
  const cfg = cds.env.requires?.[REMOTE];
  return !!(cfg?.credentials || cfg?.binding);
}

/**
 * Destination for the Cloud SDK: by name when deployed (proxy / Cloud Connector
 * handled by the destination service), or built from the user-provided service
 * the `s4` profile binds. Same resolution as srv/server.js uses for the OData proxy.
 */
async function destination() {
  const srv = await cds.connect.to(REMOTE);
  const c = srv.options?.credentials || cds.env.requires[REMOTE].credentials || {};
  if (c.destination) return { destinationName: c.destination };
  if (!c.url) throw new Error(`${REMOTE} has neither a destination nor a url`);
  return {
    url: c.url.replace(/([^:])\/{2,}/g, '$1/'),   // a pasted "…:44300//sap/…" breaks the SRT path
    authentication: 'BasicAuthentication',
    username: c.username,
    password: c.password
  };
}

/** POST the envelope; resolves with the raw response XML (also for SOAP faults). */
async function send(xml) {
  try {
    const response = await executeHttpRequest(await destination(), {
      method: 'post',
      url: '',
      data: xml,
      headers: {
        'content-type': 'text/xml; charset=utf-8',
        accept: 'text/xml',
        SOAPAction: `${SFIN_NS}/JournalEntryCreateRequestConfirmation_In/JournalEntryCreateRequestConfirmation_InRequest`
      }
    }, { fetchCsrfToken: false });
    return String(response.data);
  } catch (err) {
    // A SOAP fault arrives as HTTP 500 with the fault in the body — let the parser read it.
    const body = err?.response?.data ?? err?.cause?.response?.data;
    if (typeof body === 'string' && /faultstring/.test(body)) return body;
    const status = err?.response?.status ?? err?.cause?.response?.status;
    throw new Error(`Journal Entry SOAP call failed${status ? ` (${status})` : ''}: ${err.message}`);
  }
}

module.exports = { buildEnvelope, parseResponse, send, isConfigured, alpha, netAmounts };
