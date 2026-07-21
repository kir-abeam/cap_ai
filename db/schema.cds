namespace abeam.invoicereview;

using { cuid, managed, sap.common.CodeList } from '@sap/cds/common';

/**
 * Combined entity: email metadata + invoice header + compositions.
 *
 * This models the contract that a single combined S/4HANA OData service will
 * eventually implement. For now it is persisted locally (SQLite/HANA) and
 * seeded with mock data. When the S/4 service is ready, this entity becomes a
 * projection on the imported remote service (see the project plan).
 *
 * Field mapping vs. the existing DocumentProcessingService AI types:
 *   documentNumber      <- invoiceNumber
 *   documentDate        <- invoiceDate
 *   vendorCode          <- payeeCode
 *   vendorName          <- payeeName
 *   vendorAccountNumber <- payeeAccountNumber
 */
entity Invoices : cuid, managed {
  // --- email metadata ---
  emailSubject        : String(255);
  emailSentDate       : DateTime;
  emailSender         : String(241);       // RFC 5321 max local+domain
  emailBodyHtml       : LargeString;       // raw HTML, rendered in a custom section

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
  content   : LargeBinary  @Core.MediaType: mediaType  @Core.ContentDisposition.Filename: fileName;
  size      : Integer;
}

/** Verification status code list: carries Criticality for FE coloring + value help. */
entity VerificationStatuses : CodeList {
  key code    : String(1);   // 'P' Pending, 'V' Verified, 'R' Rejected
  criticality : Integer;     // 1=Rejected(red), 2=Pending(yellow), 3=Verified(green)
}
