using { abeam.invoicereview as ir } from '../db/schema';

service InvoiceReviewService @(path: '/invoice-review') {

  @odata.draft.enabled
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
