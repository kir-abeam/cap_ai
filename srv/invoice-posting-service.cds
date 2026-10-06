/**
 * Verify = post. A Pending invoice is posted to S/4 as an FI vendor invoice
 * (document type KR, the FB60 equivalent) through the standard SOAP service
 * JournalEntryCreateRequestConfirmation_In. Only when S/4 accepts it is the
 * invoice marked Verified, together with the resulting accounting document;
 * otherwise it stays Pending (and editable) and the reasons are returned.
 *
 * Served under /odata/v4/… on purpose: both approuter configs already route
 * ^/odata/ to srv-api, so the Fiori app reaches it with no extra route — locally,
 * standalone and from Work Zone.
 */
service InvoicePostingService @(path: '/odata/v4/invoice-posting') {

    type PostingMessage {
        severity : String;   // info | warning | error
        text     : String;
    }

    type PostingResult {
        accountingDocument : String(10);
        fiscalYear         : String(4);
        companyCode        : String(4);
        target             : String;      // 'local' (mock, nothing posted) | 's4'
        verificationStatus : String(1);
        messages           : many PostingMessage;
    }

    // Verify = post: Pending -> posted in S/4 -> Verified. Any failure leaves it Pending.
    action verifyInvoice(invoiceUUID : UUID) returns PostingResult;
}
