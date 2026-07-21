using InvoiceReviewService from '../../srv/invoice-review-service';

// ==================================================================
// Emails: List Report + Email Object Page (read-only grouping)
// ==================================================================
annotate InvoiceReviewService.Emails with @(

  UI.HeaderInfo : {
    TypeName       : 'Email',
    TypeNamePlural : 'Emails',
    Title          : { $Type: 'UI.DataField', Value: emailSubject },
    Description    : { $Type: 'UI.DataField', Value: emailSender }
  },

  // Filter bar. (The rollup status is computed per-read and not persisted, so
  // it is not a filterable field — only real columns go here.)
  UI.SelectionFields : [
    emailSender,
    emailSentDate
  ],

  // List Report columns — one row per email, with the rollup status colored.
  UI.LineItem : [
    { $Type: 'UI.DataField', Value: emailSubject,  Label: 'Email Subject' },
    { $Type: 'UI.DataField', Value: emailSentDate, Label: 'Email Sent Date' },
    { $Type: 'UI.DataField', Value: emailSender,   Label: 'Email Sender' },
    {
      $Type      : 'UI.DataField',
      Value      : statusSummary,
      Criticality: statusCriticality,
      Label      : 'Invoices'
    }
  ],

  // Email Object Page. The email-body section is injected as a manifest custom
  // section (see app/documentprocessing/webapp/manifest.json), positioned
  // before the invoices table.
  UI.Facets : [
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'InvoicesFacet',
      Label : 'Invoices',
      Target: 'invoices/@UI.LineItem'
    }
  ]
);

// Emails are the draft root (so invoices are editable within the draft), but
// they arrive from ingestion — no creating/deleting emails from the UI.
annotate InvoiceReviewService.Emails with @(
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.DeleteRestrictions.Deletable : false
);

// ==================================================================
// Invoices: the table shown on the Email OP + the Invoice Object Page
// (its own draft root — independently editable / verifiable)
// ==================================================================
annotate InvoiceReviewService.Invoices with @(

  UI.HeaderInfo : {
    TypeName       : 'Invoice',
    TypeNamePlural : 'Invoices',
    Title          : { $Type: 'UI.DataField', Value: documentNumber },
    Description    : { $Type: 'UI.DataField', Value: vendorName }
  },

  // Columns of the invoices table on the Email OP (rows navigate to the
  // Invoice OP via the Emails/invoices route).
  UI.LineItem : [
    { $Type: 'UI.DataField', Value: documentNumber, Label: 'Document Number' },
    { $Type: 'UI.DataField', Value: vendorName,     Label: 'Vendor Name' },
    { $Type: 'UI.DataField', Value: totalAmount,    Label: 'Total Amount' },
    { $Type: 'UI.DataField', Value: currency,       Label: 'Currency' },
    {
      $Type      : 'UI.DataField',
      Value      : verificationStatus.name,
      Criticality: verificationStatus.criticality,
      Label      : 'Verification Status'
    }
  ],

  // Invoice Object Page layout.
  UI.Facets : [
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'HeaderFacet',
      Label : 'Invoice Header',
      Target: '@UI.FieldGroup#Header'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'ItemsFacet',
      Label : 'Line Items',
      Target: 'lineItems/@UI.LineItem'
    }
  ],

  UI.FieldGroup #Header : {
    Data : [
      { $Type: 'UI.DataField', Value: documentNumber,      Label: 'Document Number' },
      { $Type: 'UI.DataField', Value: documentDate,        Label: 'Document Date' },
      { $Type: 'UI.DataField', Value: totalAmount,         Label: 'Total Amount' },
      { $Type: 'UI.DataField', Value: currency,            Label: 'Currency' },
      { $Type: 'UI.DataField', Value: taxAmount,           Label: 'Tax Amount' },
      { $Type: 'UI.DataField', Value: vendorCode,          Label: 'Vendor Code' },
      { $Type: 'UI.DataField', Value: vendorName,          Label: 'Vendor Name' },
      { $Type: 'UI.DataField', Value: vendorAccountNumber, Label: 'Vendor Account Number' }
    ]
  },

  // Object Page header actions
  UI.Identification : [
    { $Type: 'UI.DataFieldForAction', Action: 'InvoiceReviewService.verify', Label: 'Verify' },
    { $Type: 'UI.DataFieldForAction', Action: 'InvoiceReviewService.rejectInvoice', Label: 'Reject' }
  ]
);

// ------------------------------------------------------------------
// Editability lock: the Invoice Object Page becomes read-only once the
// record is no longer Pending (isEditable = false). The Edit button and
// every input (header fields + line-item add/edit/delete) disappear.
// ------------------------------------------------------------------
annotate InvoiceReviewService.Invoices with @(
  Capabilities.UpdateRestrictions       : { Updatable: isEditable },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.DeleteRestrictions.Deletable : false
);

// ------------------------------------------------------------------
// Status value help + text arrangement
// ------------------------------------------------------------------
annotate InvoiceReviewService.Invoices {
  verificationStatus @(
    Common.Text                     : verificationStatus.name,
    Common.Text.@UI.TextArrangement : #TextOnly,
    Common.ValueListWithFixedValues
  );
}

// ------------------------------------------------------------------
// Line-items table columns (editable in draft mode)
// ------------------------------------------------------------------
annotate InvoiceReviewService.InvoiceLineItems with @(
  UI.LineItem : [
    { $Type: 'UI.DataField', Value: amount,        Label: 'Amount' },
    { $Type: 'UI.DataField', Value: glAccount,     Label: 'GL Account' },
    { $Type: 'UI.DataField', Value: costCenter,    Label: 'Cost Center' },
    { $Type: 'UI.DataField', Value: internalOrder, Label: 'Internal Order' }
  ]
);
