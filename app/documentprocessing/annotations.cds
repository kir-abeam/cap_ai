using InvoiceReviewService from '../../srv/invoice-review-service';

// UI annotations for the CAP MOCK service. Field/entity names match S/4, so
// these mirror app/documentprocessing/webapp/annotations/annotations.xml (used
// when the app points at live S/4). Keep the two in sync.

// ==================================================================
// Email: List Report + Email Object Page
// ==================================================================
annotate InvoiceReviewService.Email with @(

  UI.HeaderInfo : {
    TypeName       : 'Email',
    TypeNamePlural : 'Emails',
    Title          : { $Type: 'UI.DataField', Value: EmailSubject },
    Description    : { $Type: 'UI.DataField', Value: EmailSender }
  },

  UI.SelectionFields : [ EmailSender, EmailSentDate ],

  UI.LineItem : [
    { $Type: 'UI.DataField', Value: EmailSubject,  Label: 'Email Subject' },
    { $Type: 'UI.DataField', Value: EmailSentDate, Label: 'Email Sent Date' },
    { $Type: 'UI.DataField', Value: EmailSender,   Label: 'Email Sender' }
  ],

  UI.Facets : [
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'InvoicesFacet',
      Label : 'Invoices',
      Target: '_Invoice/@UI.LineItem'
    }
  ]
);

// Emails arrive from ingestion: hide Create in the UI (API stays open), block Delete.
annotate InvoiceReviewService.Email with @(
  UI.CreateHidden                           : true,
  Capabilities.DeleteRestrictions.Deletable : false
);

// ==================================================================
// Invoice: table on the Email OP + the Invoice Object Page
// ==================================================================
annotate InvoiceReviewService.Invoice with @(

  UI.HeaderInfo : {
    TypeName       : 'Invoice',
    TypeNamePlural : 'Invoices',
    Title          : { $Type: 'UI.DataField', Value: DocumentNumber },
    Description    : { $Type: 'UI.DataField', Value: VendorName }
  },

  UI.LineItem : [
    { $Type: 'UI.DataField', Value: DocumentNumber,     Label: 'Document Number' },
    { $Type: 'UI.DataField', Value: VendorName,         Label: 'Vendor Name' },
    { $Type: 'UI.DataField', Value: TotalAmount,        Label: 'Total Amount' },
    { $Type: 'UI.DataField', Value: Currency,           Label: 'Currency' },
    { $Type: 'UI.DataField', Value: VerificationStatus, Label: 'Verification Status' }
  ],

  UI.Facets : [
    { $Type: 'UI.ReferenceFacet', ID: 'HeaderFacet', Label: 'Invoice Header', Target: '@UI.FieldGroup#Header' },
    { $Type: 'UI.ReferenceFacet', ID: 'ItemsFacet',  Label: 'Line Items',     Target: '_Item/@UI.LineItem' }
  ],

  UI.FieldGroup #Header : {
    Data : [
      { $Type: 'UI.DataField', Value: DocumentNumber,      Label: 'Document Number' },
      { $Type: 'UI.DataField', Value: DocumentDate,        Label: 'Document Date' },
      { $Type: 'UI.DataField', Value: TotalAmount,         Label: 'Total Amount' },
      { $Type: 'UI.DataField', Value: Currency,            Label: 'Currency' },
      { $Type: 'UI.DataField', Value: TaxAmount,           Label: 'Tax Amount' },
      { $Type: 'UI.DataField', Value: VendorCode,          Label: 'Vendor Code' },
      { $Type: 'UI.DataField', Value: VendorName,          Label: 'Vendor Name' },
      { $Type: 'UI.DataField', Value: VendorAccountNumber, Label: 'Vendor Account Number' },
      { $Type: 'UI.DataField', Value: VerificationStatus,  Label: 'Verification Status' }
    ]
  }
);

// ==================================================================
// InvoiceItem: line-items table columns
// ==================================================================
annotate InvoiceReviewService.InvoiceItem with @(
  UI.LineItem : [
    { $Type: 'UI.DataField', Value: Amount,        Label: 'Amount' },
    { $Type: 'UI.DataField', Value: GLAccount,     Label: 'GL Account' },
    { $Type: 'UI.DataField', Value: CostCenter,    Label: 'Cost Center' },
    { $Type: 'UI.DataField', Value: InternalOrder, Label: 'Internal Order' }
  ]
);
