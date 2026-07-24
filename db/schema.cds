namespace abeam.invoicereview;

using { cuid, managed, sap.common.CodeList } from '@sap/cds/common';

/**
 * Email grouping parent. One incoming email can carry many invoices (e.g. a
 * single email with several attached invoice PDFs), so the email metadata now
 * lives on its own entity and the invoices hang off it via an association.
 *
 * Emails is a read-only grouping in the UI: the List Report lists emails, and
 * the Email Object Page shows the body + a table of its invoices. Each invoice
 * is edited/verified independently on its own (draft-enabled) Object Page.
 *
 * This models the contract that a single combined S/4HANA OData service will
 * eventually implement (email header + invoice children). For now it is
 * persisted locally (SQLite/HANA) and seeded with mock data.
 */
entity Emails : cuid, managed {
  // --- email metadata ---
  emailSubject      : String(255);
  emailSentDate     : DateTime;
  emailSender       : String(241);         // RFC 5321 max local+domain
  emailBodyHtml     : LargeString;         // raw HTML, rendered in a custom section
  summary           : LargeString;         // raw HTML, rendered in a custom section

  // --- invoices carried by this email ---
  // Composition (contained) so the email is the draft root and its invoice
  // sub-object-pages are editable within the draft (FE master-detail pattern).
  invoices          : Composition of many Invoices on invoices.email = $self;

  // --- rollup of the child invoices' verification statuses (see service .js) ---
  // Computed in an after-READ handler (a to-many rollup can't be a plain calc).
  virtual statusCriticality : Integer;     // most severe among child invoices
  virtual statusSummary     : String(40);  // e.g. "3 · 1 pending"
}

/**
 * Invoice header + line items + attachments. Child of Emails, but its own
 * draft root (independently editable / verifiable).
 *
 * Field mapping vs. the existing DocumentProcessingService AI types:
 *   documentNumber      <- invoiceNumber
 *   documentDate        <- invoiceDate
 *   vendorCode          <- payeeCode
 *   vendorName          <- payeeName
 *   vendorAccountNumber <- payeeAccountNumber
 */
entity Invoices : cuid, managed {
  // --- parent email (owning side -> generates email_ID FK) ---
  email               : Association to Emails;

  // --- invoice header (editable) ---
  documentNumber      : String(60);
  documentDate        : Date;
  totalAmount         : Decimal(15, 2);
  currency            : String(3);         // ISO 4217 code
  taxAmount           : Decimal(15, 2);
  vendorCode          : String(40);
  vendorName          : String(255);
  vendorAccountNumber : String(60);

  // --- verification ---
  verificationStatus  : Association to VerificationStatuses default 'P';

  // --- compositions ---
  lineItems           : Composition of many InvoiceLineItems on lineItems.invoice = $self;
  attachments         : Composition of many Attachments      on attachments.invoice = $self;

  // --- derived editability flag (calculated on read) ---
  // Single source of truth for both "can edit" and "can verify/reject":
  // editable only while Pending. Drives UpdateRestrictions + OperationAvailable.
  isEditable          : Boolean = verificationStatus.code = 'P';
}

/** Additional posting details the business user adds to the invoice. */
entity InvoiceLineItems : cuid {
  invoice       : Association to Invoices;
  amount        : Decimal(15, 2);
  glAccount     : String(10);
  costCenter    : String(10);
  internalOrder : String(12);
}

/** Media entity for binary attachments (XSTRING in S/4 -> LargeBinary here). */
entity Attachments : cuid {
  invoice   : Association to Invoices;
  fileName  : String(255);
  mediaType : String(120)  @Core.IsMediaType;
  // ContentDisposition.Type 'inline' so the browser *displays* the file (PDF /
  // image) in the tab instead of downloading it. Without it CAP defaults to
  // 'attachment' whenever a Filename is set (see @sap/cds streaming util).
  content   : LargeBinary  @Core.MediaType: mediaType  @Core.ContentDisposition.Filename: fileName  @Core.ContentDisposition.Type: 'inline';
  size      : Integer;
}

/** Verification status code list: carries Criticality for FE coloring + value help. */
entity VerificationStatuses : CodeList {
  key code    : String(1);   // 'P' Pending, 'V' Verified, 'R' Rejected
  criticality : Integer;     // 1=Rejected(red), 2=Pending(yellow), 3=Verified(green)
}
