using { abeam.invoicereview as ir } from '../db/schema';

service InvoiceReviewService @(path: '/invoice-review') {

  // Email grouping parent. NON-DRAFT: required for the S/4 delegation to work —
  // with @odata.draft.enabled, FE emits draft-shaped queries (IsActiveEntity,
  // SiblingEntity, DraftAdministrativeData) that can't be translated to the
  // remote S/4 service, which manages its own draft. The s4-proxy write
  // handlers drive S/4's draft flow under the hood; FE sees a plain service.
  // The after-READ handler hydrates the rollup status virtual fields.
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
