service DocumentProcessingService @(path: '/document-processing-service') {

    action getInvoicePages(fileContent: LargeString) returns many PageRange;

    action extractInvoice(invoiceContent: LargeString,
                          emailContent: LargeString,
                          ocrResults: LargeString)   returns InvoiceHeader;

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
