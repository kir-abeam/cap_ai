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

  entity Invoice     as projection on ir.Invoice;
  entity InvoiceItem as projection on ir.InvoiceItem;
  entity Attachment  as projection on ir.Attachment;
}
