/*
 * External service model for the S/4HANA invoice-review OData V4 service
 * (com.sap.gateway.srvd_a2x.zui_invoice_review_o4.v0001).
 *
 * Hand-authored from srv/external/ZUI_INVOICE_REVIEW_O4.edmx (the source of
 * record) because @sap/cds-dk's `cds import` isn't available in this env. If
 * you have cds-dk, you can regenerate with:
 *   cds import srv/external/ZUI_INVOICE_REVIEW_O4.edmx --as cds
 *
 * The service is DRAFT-ENABLED on S/4: every entity's key includes
 * IsActiveEntity, and writes go through the Email-rooted draft flow
 * (Edit -> PATCH draft -> Activate). Only the shape needed to consume it as a
 * remote service is modelled here; UI/draft/capability annotations are omitted.
 */
service ZUI_INVOICE_REVIEW_O4 {

  entity Email {
    key EmailUUID           : UUID;
    key IsActiveEntity      : Boolean;
        EmailSubject        : String(255);
        EmailSentDate       : Timestamp;
        EmailSender         : String(241);
        EmailBodyHtml       : LargeString;
        Summary             : LargeString;
        CreatedBy           : String(50);
        CreatedAt           : Timestamp;
        LastChangedBy       : String(50);
        LastChangedAt       : Timestamp;
        HasActiveEntity     : Boolean;
        HasDraftEntity      : Boolean;
        _Invoice            : Association to many Invoice on _Invoice.EmailUUID = EmailUUID;
  }

  entity Invoice {
    key InvoiceUUID         : UUID;
    key IsActiveEntity      : Boolean;
        EmailUUID           : UUID;
        DocumentNumber      : String(60);
        DocumentDate        : Date;
        TotalAmount         : Decimal(15, 2);
        Currency            : String(3);
        TaxAmount           : Decimal(15, 2);
        VendorCode          : String(40);
        VendorName          : String(255);
        VendorAccountNumber : String(60);
        VerificationStatus  : String(1);
        CreatedBy           : String(50);
        CreatedAt           : Timestamp;
        LastChangedBy       : String(50);
        LastChangedAt       : Timestamp;
        HasActiveEntity     : Boolean;
        HasDraftEntity      : Boolean;
        _Email              : Association to Email       on _Email.EmailUUID = EmailUUID;
        _Item               : Association to many InvoiceItem on _Item.InvoiceUUID = InvoiceUUID;
        _Attachment         : Association to many Attachment  on _Attachment.InvoiceUUID = InvoiceUUID;
  }

  entity InvoiceItem {
    key ItemUUID            : UUID;
    key IsActiveEntity      : Boolean;
        InvoiceUUID         : UUID;
        EmailUUID           : UUID;
        Amount              : Decimal(15, 2);
        GLAccount           : String(10);
        CostCenter          : String(10);
        InternalOrder       : String(12);
        HasActiveEntity     : Boolean;
        HasDraftEntity      : Boolean;
        _Invoice            : Association to Invoice on _Invoice.InvoiceUUID = InvoiceUUID;
  }

  entity Attachment {
    key AttachmentUUID      : UUID;
    key IsActiveEntity      : Boolean;
        InvoiceUUID         : UUID;
        EmailUUID           : UUID;
        FileName            : String(255);
        MediaType           : String(120);
        Content             : LargeBinary;
        FileSize            : Integer;
        HasActiveEntity     : Boolean;
        HasDraftEntity      : Boolean;
        _Invoice            : Association to Invoice on _Invoice.InvoiceUUID = InvoiceUUID;
  }
}
