const cds = require('@sap/cds');

const fs = require('fs');
const path = require('path');

const { splitPdf, pageCount } = require('./lib/pdf-split');
const invoiceWriter = require('./lib/invoice-writer');

module.exports = class DocumentProcessingService extends cds.ApplicationService {

    async init() {

        // The one-call pipeline. The individual actions below remain exposed so
        // each stage can still be exercised on its own.
        this.on('processEmail', async (req) => {
            const { files, email } = req.data;

            try {
                return await this._processEmail(files, email);

            } catch (error) {
                console.error(error.response?.data);
                console.error(error.response?.status);
                console.error(error);
                req.error(500, 'Failed to process email: ' + error.message);
            }
        });

        this.on('summarizeEmail', async (req) => {
            const { files, email } = req.data;

            try {
                const aiResponse = await this._summarizeEmail(
                    files, email?.subject, this._decodeEmailBody(email?.content));
                return this._parseAIJson(aiResponse);

            } catch (error) {
                console.error(error.response?.data);
                console.error(error.response?.status);
                console.error(error);
                req.error(500, 'Failed to generate AI response: ' + error.message);
            }
        });

        this.on('getInvoicePages', async (req) => {
            const { fileContent } = req.data;

            try {
                const aiResponse = await this._getInvoicePages(fileContent);
                return this._parseAIJson(aiResponse);

            } catch (error) {
                console.error('AI generation error:', error);
                req.error(500, 'Failed to generate AI response: ' + error.message);
            }
        });

        this.on('extractInvoice', async (req) => {
            const { invoiceContent, emailContent } = req.data;

            try {
                const aiResponse = await this._extractInvoice(invoiceContent, emailContent);
                return this._parseAIJson(aiResponse);

            } catch (error) {
                console.error('AI generation error:', error);
                req.error(500, 'Failed to generate AI response: ' + error.message);
            }
        });

        await super.init();
    }

    // ------------------------------------------------------------------
    // Pipeline
    // ------------------------------------------------------------------

    /**
     * summarize -> page ranges -> split -> extract -> persist.
     *
     * Per-file and per-invoice failures degrade into warnings instead of
     * failing the whole email: one unreadable attachment must not cost you the
     * invoices that were extracted successfully.
     */
    async _processEmail(files, email) {
        const warnings = [];

        ({ files, email } = this._processEmailFallbacks(files, email));

        // Decoded once, and used ONLY as prompt input. email.content itself stays
        // base64 — that is what gets stored in Email.EmailBodyHtml.
        const emailHtml = this._decodeEmailBody(email.content);

        // 1. Summarize + find out which attachments are invoices.
        const { summary, invoiceFileNames } = await this._parseAIJson(
            await this._summarizeEmail(files, email.subject, emailHtml));

        // 2. Resolve those names back to the uploaded files.
        const invoiceFiles = this._matchInvoiceFiles(files, invoiceFileNames, warnings);

        // 3..5. Page ranges -> split -> extract, per file.
        const processed = [];
        for (const file of invoiceFiles) {
            try {
                const ranges = await this._resolvePageRanges(file, warnings);
                const parts = await splitPdf(file.content, ranges);

                if (!parts.length) {
                    warnings.push(`No usable page range in '${file.name}' — skipped.`);
                    continue;
                }

                const extracted = await Promise.all(parts.map(part =>
                    this._extractSplitInvoice(file, part, emailHtml, warnings)));

                processed.push(...extracted.filter(Boolean));

            } catch (error) {
                console.error(`[processEmail] '${file.name}' failed:`, error);
                warnings.push(`Failed to process '${file.name}': ${error.message}`);
            }
        }

        if (!processed.length) {
            warnings.push('No invoice could be extracted from this email; the email was created without invoices.');
        }

        // 6. Persist the email and everything extracted from it.
        const { emailUUID, target, invoiceUUIDs } = await invoiceWriter.createEmailWithInvoices({
            email,
            summary,
            invoices: processed
        });

        return {
            emailUUID,
            target,
            summary,
            warnings,
            invoices: processed.map((p, i) => ({
                invoiceUUID: invoiceUUIDs[i],
                sourceFile: p.sourceFile,
                startPage: p.startPage,
                endPage: p.endPage,
                header: p.header
            }))
        };
    }

    /** Same dev convenience the individual actions have: an empty body still exercises the full path. */
    _processEmailFallbacks(files, email) {
        const fallbackPDF = path.join(__dirname, 'Invoice.pdf');

        if (!files || !files.length) {
            files = [{ name: 'Invoice.pdf', content: fs.readFileSync(fallbackPDF).toString('base64') }];
        }

        email = { ...email };
        if (!email.subject) email.subject = 'Invoices for processing';
        if (!email.content) {
            email.content = Buffer
                .from('<html><body><p>Please park the attached invoice(s) for processing.</p></body></html>', 'utf8')
                .toString('base64');
        }
        if (!email.sender) email.sender = 'billing@example.com';

        return { files, email };
    }

    /**
     * Map the file names the summarizer reported back onto the uploaded files.
     * Compared case-insensitively on the basename, since the model tends to echo
     * the name loosely. If nothing matches, process everything rather than
     * silently dropping the email's attachments.
     */
    _matchInvoiceFiles(files, invoiceFileNames, warnings) {
        const names = Array.isArray(invoiceFileNames) ? invoiceFileNames : [];
        const key = (name) => path.basename(String(name || '')).trim().toLowerCase();
        const byName = new Map(files.map(f => [key(f.name), f]));

        const matched = [];
        for (const name of names) {
            const file = byName.get(key(name));
            if (file) matched.push(file);
            else warnings.push(`Summary listed '${name}', which is not among the uploaded files — ignored.`);
        }

        if (!matched.length) {
            warnings.push('No uploaded file matched the summarized invoice list — processing all attachments.');
            return files;
        }
        return matched;
    }

    /** Page ranges for one file, falling back to "the whole document is one invoice". */
    async _resolvePageRanges(file, warnings) {
        let ranges;
        try {
            ranges = await this._parseAIJson(await this._getInvoicePages(file.content));
        } catch (error) {
            warnings.push(`Could not read page ranges for '${file.name}' (${error.message}) — treating it as a single invoice.`);
            ranges = null;
        }

        if (!Array.isArray(ranges) || !ranges.length) {
            if (ranges !== null) {
                warnings.push(`No page range reported for '${file.name}' — treating it as a single invoice.`);
            }
            return [{ startPage: 1, endPage: await pageCount(file.content) }];
        }
        return ranges;
    }

    /** Extract one split invoice; a failure here costs only this invoice. */
    async _extractSplitInvoice(file, part, emailHtml, warnings) {
        const label = `${file.name} p${part.startPage}-${part.endPage}`;
        try {
            const header = await this._parseAIJson(
                await this._extractInvoice(part.content, emailHtml));

            return {
                sourceFile: file.name,
                startPage: part.startPage,
                endPage: part.endPage,
                header,
                attachment: {
                    fileName: this._splitFileName(file.name, part),
                    content: part.content
                }
            };
        } catch (error) {
            console.error(`[processEmail] extraction failed for ${label}:`, error);
            warnings.push(`Extraction failed for ${label}: ${error.message}`);
            return null;
        }
    }

    /** 'Invoice.pdf' + pages 3..5 -> 'Invoice_p3-5.pdf' */
    _splitFileName(sourceName, part) {
        const base = path.basename(sourceName || 'invoice.pdf').replace(/\.pdf$/i, '');
        return `${base}_p${part.startPage}-${part.endPage}.pdf`;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** Email bodies travel and are stored base64; the prompts need the HTML itself. */
    _decodeEmailBody(content) {
        if (!content) return '';
        return Buffer.from(content, 'base64').toString('utf8');
    }

    async _parseAIJson(text) {
        text = String(text).trim();

        if (text.startsWith("```")) {
            text = text
                .replace(/^```json\s*/i, "")
                .replace(/^```\s*/i, "")
                .replace(/\s*```$/, "");
        }

        return JSON.parse(text);
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

    async _runPrompt(client, systemPrompt, userPrompt, { maxTokens = 8000 } = {}) {

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

            // Generous by design: an extraction with several line items, or a
            // page-range list for a multi-invoice PDF, truncates mid-JSON at a
            // low ceiling and then fails to parse.
            max_tokens: maxTokens,
            temperature: 0.2
        });

        return response.getContent();
    }

    async _buildContentItem(fileContent, filename = 'invoice.pdf') {

        return {
            type: 'file',
            file: {
                file_data: `data:application/pdf;base64,${fileContent}`,
                filename,
            },
        };
    }

    async _buildFileItem(files) {

        return files.map((file) => ({
            type: 'file',
            file: {
                file_data: `data:application/pdf;base64,${file.content}`,
                filename: file.name,
            },
        }));
    }

    /**
     * @param emailHtml the email body as HTML (already base64-decoded by the caller —
     *                  decoding here would corrupt the value the writer has to store).
     */
    async _summarizeEmail(files, emailSubject, emailHtml) {

        const fallbackPDF = path.join(__dirname, '../srv/Invoice.pdf');
        if (files == undefined || files.length == 0) {
            files = [];
            let fileContent = fs.readFileSync(fallbackPDF).toString('base64');
            files.push({ name: "Invoice.pdf", content: fileContent });
        }

        const userContent = [
            ...(await this._buildFileItem(files)),
            {
                type: 'text',
                text:
                    `
                Email Subject: ${emailSubject ?? ''}
                Email Content in HTML: ${emailHtml ?? ''}
                `
            },
            {
                type: 'text',
                text:
                    `
                Based on the email and PDF file, please summarize the intent of the message and then output it into a nice HTML format.
                The HTML must only use standard SAP Fiori fonts and colors.
                After summarization, list all the PDF files which contains invoices.
                Use the exact file names as given above.
                Output Format (Strict JSON ONLY — No explanation):
                {
                    "summary": <HTML format of the summary>,
                    "invoiceFileNames": [<File name of invoices, ...>]
                }
                `
            }
        ];

        const client = await this._createClient();

        const response = await this._runPrompt(
            client,
            `You are an expert invoice processing system.`,
            userContent
        );

        return response;
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
                One range per invoice: a document holding three invoices yields three ranges.

                Page numbering rules:
                - Pages are numbered from 1 (the first page of the PDF is page 1).
                - Ranges are inclusive: startPage and endPage are both part of the invoice.
                - A single-page invoice has startPage equal to endPage.
                - Ranges must NOT overlap, and must be in ascending page order.
                - Pages that belong to no invoice (cover letters, terms, blank pages) are left out.

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

    async _extractInvoice(invoiceContent, emailContent) {
        const fallbackPDF = path.join(__dirname, '../srv/Invoice_3.pdf');

        if (!invoiceContent) {
            invoiceContent = fs.readFileSync(fallbackPDF).toString('base64');
        }

        if (!emailContent) {
            emailContent = "Please park the invoice for processing. The invoice is attached in this email.";
        }

        const userContent = [
            await this._buildContentItem(invoiceContent),
            {
                type: 'text',
                text:
                    `
                You will be given:
                1. The content of an invoice PDF file (base64 encoded).
                2. The content of an email.

                Email content:
                ${emailContent}

                Your task is to extract structured invoice data using the provided information as reference.

                Output Format (Strict JSON ONLY — No explanation):
                {
                    "payeeCode": "",
                    "payeeName": "",
                    "payeeAccountNumber": "",
                    "invoiceNumber": "",
                    "invoiceDate": "",
                    "totalAmount": "",
                    "currency": "",
                    "taxAmount": "",
                    "lineItems": [
                        {
                            "amount": "",
                            "glAccount": "",
                            "costCenter": "",
                            "internalOrder": ""
                        }
                    ]
                }

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
                - If not found → null

                payeeName:
                - Vendor / company name
                - If not found → null

                invoiceNumber:
                - Invoice number / reference number
                - Keywords:
                - "Invoice No"
                - "Reference"
                - "Document No"
                - If not found → null

                invoiceDate:
                - Extract invoice date
                - Convert to ISO format: YYYY-MM-DD
                - If not found → null

                totalAmount:
                - Final invoice amount
                - Must be numeric (no currency symbols)
                - If not found → null

                currency:
                - Currency code (e.g., MYR, USD, SGD)
                - If symbol is found (e.g., RM), map to ISO code if possible
                - If not found → null

                taxAmount:
                - Extract tax amount
                - Numeric only
                - If not found → null

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

                3. IF the document shows BOTH subtotal and total:
                - Use SUBTOTAL as the basis for item amounts

                - Always ensure:
                sum(item.amount) == totalAmount  (ONLY when multiple items exist)

                glAccount:
                - Must contain ONLY digits
                - May appear as "GL" or "G/L Account"
                - If not found → null

                costCenter:
                - Must match regex: \\d{3}-\\d{5}
                - Example: "102-05003" or "108-02600"
                - May appear as "CC"  or "Cost Center"
                - If not found → null

                internalOrder:
                - Must match regex: [A-Z]{3}\\d{3}-\\d{3}
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