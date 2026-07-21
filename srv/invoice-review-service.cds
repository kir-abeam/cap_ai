using { abeam.invoicereview as ir } from '../db/schema';

service InvoiceReviewService @(path: '/invoice-review') {

  // Email grouping parent AND the draft root (its invoices are a contained
  // composition, so each invoice sub-object-page is editable within the email
  // draft). Emails aren't created/deleted from the UI (see annotations); the
  // after-READ handler hydrates the rollup status virtual fields.
  @odata.draft.enabled
  entity Emails as projection on ir.Emails;

  entity Invoices as projection on ir.Invoices actions {

    @(
      Core.OperationAvailable          : { $edmJson: { $Path: 'in/isEditable' } },
      Common.SideEffects.TargetEntities: [ in ]
    )
    action verify() returns Invoices;

    @(
      Core.OperationAvailable          : { $edmJson: { $Path: 'in/isEditable' } },
      Common.SideEffects.TargetEntities: [ in ]
    )
    action rejectInvoice() returns Invoices;
  };

  entity InvoiceLineItems as projection on ir.InvoiceLineItems;

  entity Attachments      as projection on ir.Attachments;

  @readonly
  entity VerificationStatuses as projection on ir.VerificationStatuses;
}
