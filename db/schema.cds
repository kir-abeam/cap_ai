namespace abeam.invoicereview;

/**
 * Local mock model that MIRRORS the S/4 service ZUI_INVOICE_REVIEW_O4 — same
 * entity names, key names (UUIDs), field names and navigation names. Because
 * the model matches S/4 1:1, the Fiori app runs against either backend by
 * swapping only the manifest `dataSource` (mock = this CAP service, live = the
 * S/4 OData service). No field/entity renames on switch.
 *
 * S/4 is draft-enabled, so the CAP service draft-enables Email too (the app
 * gets the same Edit/Save/draft UX + IsActiveEntity key shape on mock data).
 */
entity Email {
  key EmailUUID   : UUID;
      EmailSubject  : String(255);
      EmailSentDate : Timestamp;                 // S/4 DateTimeOffset
      EmailSender   : String(241);
      EmailBodyHtml : LargeString;
      Summary       : LargeString;
      _Invoice      : Composition of many Invoice on _Invoice.EmailUUID = EmailUUID;
}

entity Invoice {
  key InvoiceUUID         : UUID;
      EmailUUID           : UUID;                // FK to Email
      DocumentNumber      : String(60);
      DocumentDate        : Date;
      TotalAmount         : Decimal(15, 2);
      Currency            : String(3);
      TaxAmount           : Decimal(15, 2);
      VendorCode          : String(40);
      VendorName          : String(255);
      VendorAccountNumber : String(60);
      VerificationStatus  : String(1) default 'P';   // P Pending / V Verified / R Rejected
      _Email              : Association to Email on _Email.EmailUUID = EmailUUID;
      _Item               : Composition of many InvoiceItem on _Item.InvoiceUUID = InvoiceUUID;
      _Attachment         : Composition of many Attachment  on _Attachment.InvoiceUUID = InvoiceUUID;
}

entity InvoiceItem {
  key ItemUUID      : UUID;
      InvoiceUUID   : UUID;                       // FK to Invoice
      EmailUUID     : UUID;                       // owning email (S/4 carries it too)
      Amount        : Decimal(15, 2);
      GLAccount     : String(10);
      CostCenter    : String(10);
      InternalOrder : String(12);
      _Invoice      : Association to Invoice on _Invoice.InvoiceUUID = InvoiceUUID;
}

entity Attachment {
  key AttachmentUUID : UUID;
      InvoiceUUID    : UUID;                      // FK to Invoice
      EmailUUID      : UUID;
      FileName       : String(255);
      MediaType      : String(120)  @Core.IsMediaType;
      Content        : LargeBinary  @Core.MediaType: MediaType  @Core.ContentDisposition.Filename: FileName  @Core.ContentDisposition.Type: 'inline';
      FileSize       : Integer;
      _Invoice       : Association to Invoice on _Invoice.InvoiceUUID = InvoiceUUID;
}
