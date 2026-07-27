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

    action getInvoicePages(fileContent: LargeString) returns many PageRange;

    action extractInvoice(invoiceContent: LargeString,
                          emailContent: LargeString) returns InvoiceHeader;

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
