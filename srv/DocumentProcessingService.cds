service DocumentProcessingService @(path: '/document-processing-service') {

    /**
     * The one-call pipeline: summarize the email -> identify invoice page ranges
     * in each attachment -> split the PDF per range -> extract each invoice ->
     * create Email/Invoice/InvoiceItem/Attachment in the invoice-review backend
     * (S/4 when its binding resolves, otherwise the local tables).
     */
    action processEmail(files: many File,
                        email: Email)            returns ProcessEmailResult;

    // The individual stages stay exposed for per-stage debugging; they share the
    // same helpers the pipeline uses.
    action summarizeEmail(files: many File,
                          email: Email)          returns SummaryOutput;

    /**
     * Which prompt set `processEmail` will route this file to:
     * 'invoice'      -> getInvoicePages + extractInvoice
     * 'payment_memo' -> getMemoPages    + extractMemoInvoices
     */
    action classifyDocument(fileContent: LargeString) returns DocumentClassification;

    action getInvoicePages(fileContent: LargeString) returns many PageRange;

    action extractInvoice(invoiceContent: LargeString,
                          emailContent: LargeString) returns InvoiceHeader;

    // ---- Payment memos -------------------------------------------------
    // Covering memos / disbursement schedules whose appendix tables list one
    // payee per row. Same two stages as above, but the reading rule is the
    // opposite: there, one document is one invoice; here, one TABLE ROW is one
    // invoice and the covering memo only supplies shared context. Kept as
    // separate actions so the invoice prompts above stay untouched.
    // `processEmail` picks between the two on its own — see `classifyDocument`.

    /**
     * Page ranges, memo-aware: a covering memo and ALL of its appendix pages
     * form ONE range. Same 1-based, inclusive, non-overlapping contract as
     * `getInvoicePages` — the splitter depends on it.
     */
    action getMemoPages(fileContent: LargeString) returns many PageRange;

    /**
     * One `InvoiceHeader` per payable row, across every appendix table in the
     * memo. Grand-total and subtotal rows are not invoices and are skipped.
     */
    action extractMemoInvoices(memoContent: LargeString,
                               emailContent: LargeString) returns many InvoiceHeader;

}

type File {
    name    : String;
    content : LargeString;
}

type Email {
    subject  : String;
    content  : LargeString; // base64-encoded HTML — stored as-is in Email.EmailBodyHtml
    sender   : String;      // -> Email.EmailSender
    sentDate : Timestamp;   // -> Email.EmailSentDate
}

type SummaryOutput {
    summary          : LargeString;
    invoiceFileNames : many String;
}

type ProcessEmailResult {
    emailUUID : UUID;         // key of the created Email
    target    : String;       // 's4' | 'local' — which backend was written
    summary   : LargeString;  // AI summary as plain HTML (stored base64-encoded)
    invoices  : many ProcessedInvoice;
    warnings  : many String;  // non-fatal issues (unmatched file name, skipped invoice, ...)
}

type ProcessedInvoice {
    invoiceUUID : UUID;
    sourceFile  : String;
    startPage   : Integer;
    endPage     : Integer;
    header      : InvoiceHeader; // what was extracted, as persisted
}

type InvoiceHeader {
    invoiceNumber      : String;
    invoiceDate        : Date;
    totalAmount        : Decimal(15, 2);
    currency           : String;
    taxAmount          : Decimal(15, 2);
    payeeCode          : String;
    payeeName          : String;
    payeeAccountNumber : String;
    lineItems          : many InvoiceLineItem;
}

type InvoiceLineItem {
    amount        : Decimal(15, 2);
    glAccount     : String;
    costCenter    : String;
    internalOrder : String;
}

type PageRange {
    startPage : Integer;
    endPage   : Integer;
}

type DocumentClassification {
    documentType : String; // 'invoice' | 'payment_memo'
    confidence   : Decimal(3, 2);
    reason       : String;
}
