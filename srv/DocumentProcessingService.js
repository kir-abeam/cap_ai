const cds = require('@sap/cds');

const fs   = require('fs');
const path = require('path');

module.exports = class DocumentProcessingService extends cds.ApplicationService {

    async init() {

        this.on('getInvoicePages', async (req) => {
            const { fileContent } = req.data;

            try {
                const aiResponse = await this._getInvoicePages(fileContent);
                return JSON.parse(aiResponse);
                
            } catch (error) {
                console.error('AI generation error:', error);
                req.error(500, 'Failed to generate AI response: ' + error.message);
            }
        });

        this.on('extractInvoice', async (req) => {
            const { invoiceContent, emailContent, ocrResults } = req.data;

            try {
                const aiResponse = await this._extractInvoice(invoiceContent, emailContent, ocrResults);
                return JSON.parse(aiResponse);
                
            } catch (error) {
                console.error('AI generation error:', error);
                req.error(500, 'Failed to generate AI response: ' + error.message);
            }
        });

        await super.init();
    }

    async _createClient() {
        const { OrchestrationClient } = require('@sap-ai-sdk/orchestration');

        const MODEL_NAME = process.env.AICORE_INVOICE_MODEL ?? 'anthropic--claude-4.6-sonnet';
        const RESOURCE_GROUP = process.env.AICORE_RESOURCE_GROUP ?? 'abmy-project';

        return new OrchestrationClient(
            {
                promptTemplating: {
                    model: { name: MODEL_NAME, version: 'latest' },
                },
            },
            { resourceGroup: RESOURCE_GROUP }
        );
    }

    async _runPrompt(client, systemPrompt, userPrompt) {

        const response = await client.chatCompletion({
            messages: [
                {
                    role: 'system',
                    content: systemPrompt
                },
                {
                    role: 'user',
                    content: userPrompt
                }
            ],

            max_tokens: 500,
            temperature: 0.2
        });

        return response.getContent();
    }

    async _buildContentItem(fileContent) {

        return {
            type: 'file',
            file: {
                file_data: `data:application/pdf;base64,${fileContent}`,
                filename: 'invoice.pdf',
            },
        };
    }

    async _getInvoicePages(fileContent) {

        const fallbackPDF = path.join(__dirname, '../srv/Invoice.pdf');

        if (!fileContent) {
            fileContent = fs.readFileSync(fallbackPDF).toString('base64');
        }

        const userContent = [
            await this._buildContentItem(fileContent),
            {
                type: 'text',
                text: 
                `
                Based on the content of a PDF file, please identify the page ranges that contain invoice data. 
                Output Format (Strict JSON ONLY — No explanation):
                [
                    {
                        "startPage": <number>,
                        "endPage": <number>
                    },
                    ...
                ]
                `,
            },
        ];

        const client = await this._createClient();

        const response = await this._runPrompt(
            client,
            `You are an expert invoice data extraction system.`,
            userContent
        );

        return response;
    }

    async _extractInvoice(invoiceContent, emailContent, ocrResults) {
        const fallbackPDF = path.join(__dirname, '../srv/Invoice_3.pdf');

        if (!invoiceContent) {
            invoiceContent = fs.readFileSync(fallbackPDF).toString('base64');
        }

        if (!emailContent) {
            emailContent = "Please park the invoice for processing. The invoice is attached in this email.";
        }

        if (!ocrResults) {
            ocrResults = "{\"headerFields\":{\"documentNumber\":{\"value\":\"25016078\",\"rawValue\":\"25016078\",\"page\":1,\"confidence\":0.9015243053436279,\"type\":\"string\"},\"taxId\":{\"page\":1,\"confidence\":0},\"taxName\":{\"value\":\"Service Tax\",\"rawValue\":\"Service Tax\",\"page\":1,\"confidence\":0.8964300453662872,\"type\":\"string\"},\"purchaseOrderNumber\":{\"page\":1,\"confidence\":0},\"shippingAmount\":{\"page\":1,\"confidence\":0},\"netAmount\":{\"value\":271000,\"rawValue\":\"271,000.00\",\"page\":1,\"confidence\":0.8727914690971375,\"type\":\"number\"},\"grossAmount\":{\"value\":292680,\"rawValue\":\"RM292,680.00\",\"page\":1,\"confidence\":0.8967087268829346,\"type\":\"number\"},\"currencyCode\":{\"value\":\"MYR\",\"rawValue\":\"MYR\",\"page\":1,\"confidence\":0.7898872494697571,\"type\":\"string\"},\"receiverContact\":{\"value\":\"Wan Munirah Wan Abdul Rahman)\",\"rawValue\":\"Wan Munirah Wan Abdul Rahman)\",\"page\":1,\"confidence\":0.8774975061416626,\"type\":\"string\"},\"documentDate\":{\"value\":\"2025-12-10\",\"rawValue\":\"10 December 2025\",\"page\":1,\"confidence\":0.8992494146029154,\"type\":\"date\"},\"taxAmount\":{\"value\":21680,\"rawValue\":\"21,680.00\",\"page\":1,\"confidence\":0.908001184463501,\"type\":\"number\"},\"taxRate\":{\"value\":8,\"rawValue\":\"8%\",\"page\":1,\"confidence\":0.9070632457733154,\"type\":\"number\"},\"receiverName\":{\"value\":\"Permodalan Nasional Berhad\",\"rawValue\":\"Permodalan Nasional Berhad\",\"page\":1,\"confidence\":0.8536427617073059,\"type\":\"string\"},\"receiverAddress\":{\"value\":\"Level 91, Menara Merdeka 118 Presint Merdeka 118 50118 Kuala Lumpur\",\"rawValue\":\"Level 91, Menara Merdeka 118 Presint Merdeka 118 50118 Kuala Lumpur\",\"page\":1,\"confidence\":0.8836819421161305,\"type\":\"string\"},\"receiverTaxId\":{\"page\":1,\"confidence\":0},\"deliveryDate\":{\"page\":1,\"confidence\":0},\"paymentTerms\":{\"value\":\"days from the date of this Invoice.\",\"rawValue\":\"days from the date of this Invoice.\",\"page\":2,\"confidence\":0.6977134091513497,\"type\":\"string\"},\"deliveryNoteNumber\":{\"page\":1,\"confidence\":0},\"senderBankAccount\":{\"value\":\"21433400001867\",\"rawValue\":\"21433400001867\",\"page\":2,\"confidence\":0.9018774032592773,\"type\":\"string\"},\"senderAddress\":{\"value\":\"Level 19 Menara Milenium Jalan Damanlela Pusat Bandar Damansara 50490 Kuala Lumpur Malaysia\",\"rawValue\":\"Level 19 Menara Milenium Jalan Damanlela Pusat Bandar Damansara 50490 Kuala Lumpur Malaysia\",\"page\":1,\"confidence\":0.8484036922454834,\"type\":\"string\"},\"senderName\":{\"value\":\"Zaidlbrahim&co\",\"rawValue\":\"Zaidlbrahim&co\",\"page\":1,\"confidence\":0.7947627305984497,\"type\":\"string\"},\"dueDate\":{\"value\":\"2026-03-13\",\"rawValue\":\"13/03/2026\",\"page\":1,\"confidence\":0.9099164605140686,\"type\":\"date\"},\"discount\":{\"page\":1,\"confidence\":0},\"barcode\":{\"value\":\"https://myinvois.hasil.gov.my/K1M8F8HE569Q3D6Q92TCV3CK10/share/2S8VT1SVGF21P5RJ92TCV3CK10f7SqyD1765360953\",\"rawValue\":\"https://myinvois.hasil.gov.my/K1M8F8HE569Q3D6Q92TCV3CK10/share/2S8VT1SVGF21P5RJ92TCV3CK10f7SqyD1765360953\",\"page\":1,\"confidence\":1,\"type\":\"string\"}}";
        }

        const userContent = [
            await this._buildContentItem(invoiceContent),
            {
                type: 'text',
                text: 
                `
                You will be given:
                1. The content of an invoice PDF file (base64 encoded).
                2. The content of an email (plain text).
                3. The OCR results of the invoice PDF file (JSON format).

                Your task is to extract structured invoice data using the provided information as reference.

                Output Format (Strict JSON ONLY — No explanation):
                {{
                    "payeeCode": "",
                    "payeeName": "",
                    "payeeAccountNumber": "",
                    "invoiceNumber": "",
                    "invoiceDate": "",
                    "totalAmount": "",
                    "currency": "",
                    "taxAmount": "",
                    "item": [
                        {{
                            "amount": "",
                            "glAccount": "",
                            "costCenter": "",
                            "internalOrder": ""
                        }}
                    ]
                }}

                Follow below rules for each fields:

                -------------------------------------
                HEADER FIELDS RULES:

                payeeCode:
                - Vendor code
                - Must contain ONLY digits (0-9)
                - May appear as:
                - "Vendor Code"
                - "Confirm Vendor"
                - If non-numeric → ignore
                - If not found → null

                payeeAccountNumber:
                - Extract bank account number if present
                - No strict format
                - If not found → return the value from OCR results if available, else null

                payeeName:
                - Vendor / company name
                - If not found → return the value from OCR results if available, else null

                invoiceNumber:
                - Invoice number / reference number
                - Keywords:
                - "Invoice No"
                - "Reference"
                - "Document No"
                - If not found → return the value from OCR results if available, else null

                invoiceDate:
                - Extract invoice date
                - Convert to ISO format: YYYY-MM-DD
                - If not found → return the value from OCR results if available, else null

                totalAmount:
                - Final invoice amount
                - Must be numeric (no currency symbols)
                - If not found → return the value from OCR results if available, else null

                currency:
                - Currency code (e.g., MYR, USD, SGD)
                - If symbol is found (e.g., RM), map to ISO code if possible
                - If not found → return the value from OCR results if available, else null

                taxAmount:
                - Extract tax amount
                - Numeric only
                - If not found → return the value from OCR results if available, else null

                -------------------------------------
                LINE ITEM RULES:

                Each invoice must contain at least one item. The line items are not the line items of the invoices but rather the additional details added by the business users to the invoice to give information of which G/L account, cost center, and internal order to post the invoice to. 

                - EXTRACTION LOGIC (STRICT ORDER):

                1. IF explicit line item amounts are indicated by the business users:
                - Extract each line item amount
                - The SUM of all item amounts MUST equal totalAmount

                2. IF NO explicit line item amounts are present:
                - Assume there is ONLY ONE item
                - Set item.amount = totalAmount
                - This implies the invoice is a single-line posting (SAP-style)

                4. IF the document shows BOTH subtotal and total:
                - Use SUBTOTAL as the basis for item amounts

                - Always ensure:
                sum(item.amount) == totalAmount  (ONLY when multiple items exist)

                glAccount:
                - Must contain ONLY digits
                - May appear as "GL" or "G/L Account"
                - If not found → null

                costCenter:
                - Must match regex: \\d{{3}}-\\d{{5}}
                - Example: "102-05003" or "108-02600"
                - May appear as "CC"  or "Cost Center"
                - If not found → null

                internalOrder:
                - Must match regex: [A-Z]{{3}}\\d{{3}}-\\d{{3}}
                - Example: "PTR121-115" or "PTR121-102"
                - May appear as "IO" or "Internal Order"
                - If not found → null

                -------------------------------------
                IMPORTANT CONSTRAINTS:

                Return ONLY a valid JSON object.
                Do NOT wrap the response in markdown.
                Do NOT include any explanation, notes, or extra text.
                The first character must be { and the last character must be }.
                `,
            },
        ];

        const client = await this._createClient();

        const response = await this._runPrompt(
            client,
            `You are an AI assistant specialized in extracting structured invoice data from unstructured email and attachment contents.`,
            userContent
        );

        return response;

    }
};