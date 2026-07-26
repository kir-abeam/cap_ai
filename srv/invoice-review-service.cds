using { abeam.invoicereview as ir } from '../db/schema';

/**
 * Mock backing service for the invoice-review app. Its entity/field names match
 * the S/4 service ZUI_INVOICE_REVIEW_O4 exactly, so the same Fiori app can point
 * here (mock) or at S/4 (live) by swapping only the manifest dataSource.
 *
 * Email is the draft root (mirrors S/4's DraftRoot); its compositions become
 * draft nodes, so Edit/Save works on mock data just like on S/4.
 */
service InvoiceReviewService @(path: '/invoice-review') {

  @odata.draft.enabled
  entity Email       as projection on ir.Email;

  entity Invoice     as projection on ir.Invoice {
    *,
    // On-read lock flag: an invoice is editable only while Pending. Drives
    // @Capabilities.UpdateRestrictions.Updatable so a Verified/Rejected invoice
    // renders fully read-only (all header fields + line items), even inside the
    // owning Email's draft. UI/OData hint only — the Verify/Reject draft PATCH
    // still writes VerificationStatus.
    case when VerificationStatus = 'P' then true else false end as IsEditable : Boolean,
    // Constant UI field control = 1 (ReadOnly). Referenced by @Common.FieldControl
    // so VerificationStatus is never typed directly — even on a Pending invoice it
    // is changed only via the Verify/Reject actions. A *static* #ReadOnly is
    // dropped by the CAP compiler, so a path-based control is used. UI hint only:
    // the Verify/Reject draft PATCH still writes the status.
    1 as VerificationStatusFC : Integer,
    // Human-readable label for the P/V/R code. The stored value stays P/V/R;
    // @Common.Text + TextArrangement #TextOnly make Fiori display this instead.
    case VerificationStatus
      when 'P' then 'Pending'
      when 'V' then 'Verified'
      when 'R' then 'Rejected'
      else VerificationStatus
    end as VerificationStatusText : String(20)
  };
  entity InvoiceItem as projection on ir.InvoiceItem;
  entity Attachment  as projection on ir.Attachment;
}
