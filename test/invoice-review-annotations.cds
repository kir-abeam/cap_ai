using from '../srv/invoice-review-service';
// ------------------------------------------------------------------
// List Report + Object Page for Invoices
// ------------------------------------------------------------------
annotate InvoiceReviewService.Invoices with @(

  UI.HeaderInfo : {
    TypeName       : 'Invoice',
    TypeNamePlural : 'Invoices',
    Title          : { $Type: 'UI.DataField', Value: emailSubject },
    Description    : { $Type: 'UI.DataField', Value: vendorName }
  },

  // Filter bar
  UI.SelectionFields : [
    verificationStatus_code,
    emailSender,
    emailSentDate
  ],

  // List Report columns
  UI.LineItem : [
    { $Type: 'UI.DataField', Value: emailSubject,  Label: 'Email Subject' },
    { $Type: 'UI.DataField', Value: emailSentDate, Label: 'Email Sent Date' },
    { $Type: 'UI.DataField', Value: emailSender,   Label: 'Email Sender' },
    {
      $Type      : 'UI.DataField',
      Value      : verificationStatus.name,
      Criticality: verificationStatus.criticality,
      Label      : 'Verification Status'
    }
  ],

  // Object Page layout. The email-body section is injected as a manifest
  // custom section (see app/invoicereview/webapp/manifest.json).
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
// Editability lock: the whole Object Page becomes read-only once the
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
