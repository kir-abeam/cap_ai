const cds = require('@sap/cds');

const fs = require('fs');
const path = require('path');

const { splitPdf, pageCount, UnsplittablePdfError } = require('./lib/pdf-split');
const invoiceWriter = require('./lib/invoice-writer');
const ai = require('./lib/ai-client');
const { classifyDocument, INVOICE, PAYMENT_MEMO } = require('./lib/document-classifier');

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

        this.on('classifyDocument', async (req) => {
            const { fileContent } = req.data;

            try {
                return await classifyDocument(fileContent);

            } catch (error) {
                console.error('AI generation error:', error);
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

        this.on('getMemoPages', async (req) => {
            const { fileContent } = req.data;

            try {
                return await this._getMemoPages(fileContent);

            } catch (error) {
                console.error('AI generation error:', error);
                req.error(500, 'Failed to generate AI response: ' + error.message);
            }
        });

        this.on('extractMemoInvoices', async (req) => {
            const { memoContent, emailContent } = req.data;

            try {
                return await this._extractMemoInvoices(memoContent, emailContent);

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

        // 3..5. Route -> page ranges -> split -> extract, per file.
        const processed = [];
        for (const file of invoiceFiles) {
            try {
                const kind = await this._classifyFile(file, warnings);

                processed.push(...(kind === PAYMENT_MEMO
                    ? await this._processMemoFile(file, emailHtml, warnings)
                    : await this._processInvoiceFile(file, emailHtml, warnings)));

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

    /**
     * Which service's prompts should read this file. A classification failure is
     * not fatal: fall through to the invoice path, which is what every file took
     * before memos existed.
     */
    async _classifyFile(file, warnings) {
        try {
            const { documentType, confidence, reason } = await classifyDocument(file.content);
            console.log(`[processEmail] '${file.name}' classified as ${documentType} (${confidence}): ${reason}`);
            return documentType;

        } catch (error) {
            warnings.push(`Could not classify '${file.name}' (${error.message}) — read as an ordinary invoice.`);
            return INVOICE;
        }
    }

    /**
     * Split the file into parts, or — when pdf-lib cannot open it — keep it whole.
     *
     * Digitally signed invoices are routinely AES-encrypted, and pdf-lib cannot
     * decrypt anything. The LLM reads such a PDF perfectly well, so the only
     * capability actually lost is page splitting: extract from the original
     * bytes instead of dropping the attachment and its invoice.
     *
     * The reported page span comes from the ranges the model gave us, since the
     * page count itself is unreadable here. More than one range means the file
     * holds several invoices that cannot be separated — worth saying out loud,
     * because they will be extracted as one.
     */
    async _splitOrWhole(file, ranges, warnings) {
        try {
            return await splitPdf(file.content, ranges);

        } catch (error) {
            if (!(error instanceof UnsplittablePdfError)) throw error;

            warnings.push(`'${file.name}' could not be split (${error.message}) — processed as one document.`);

            if (Array.isArray(ranges) && ranges.length > 1) {
                warnings.push(`'${file.name}' appears to hold ${ranges.length} invoices but cannot be split — they are extracted together as one.`);
            }

            return [{ ...this._rangeSpan(ranges), content: file.content }];
        }
    }

    /** The outer bounds of a set of ranges, for reporting an unsplit document. */
    _rangeSpan(ranges) {
        const starts = [], ends = [];
        for (const range of ranges || []) {
            const start = Number(range?.startPage);
            const end = Number(range?.endPage ?? range?.startPage);
            if (Number.isFinite(start)) starts.push(Math.trunc(start));
            if (Number.isFinite(end)) ends.push(Math.trunc(end));
        }

        return {
            startPage: starts.length ? Math.max(1, Math.min(...starts)) : 1,
            endPage: ends.length ? Math.max(...ends) : 1
        };
    }

    /** The ordinary path: one document (or one page range within it) is one invoice. */
    async _processInvoiceFile(file, emailHtml, warnings) {
        const ranges = await this._resolvePageRanges(file, warnings);
        const parts = await this._splitOrWhole(file, ranges, warnings);

        if (!parts.length) {
            warnings.push(`No usable page range in '${file.name}' — skipped.`);
            return [];
        }

        const extracted = await Promise.all(parts.map(part =>
            this._extractSplitInvoice(file, part, emailHtml, warnings)));

        return extracted.filter(Boolean);
    }

    /**
     * The payment-memo path, using the memo prompts instead of the invoice ones:
     * one appendix ROW is one invoice, so a single part yields many. They share
     * that part's page range and its PDF — a row's own page is not evidence
     * without the covering memo that carries the reference, GL code and currency.
     */
    async _processMemoFile(file, emailHtml, warnings) {
        const ranges = await this._resolveMemoPages(file, warnings);
        const parts = await this._splitOrWhole(file, ranges, warnings);

        if (!parts.length) {
            warnings.push(`No usable page range in memo '${file.name}' — skipped.`);
            return [];
        }

        const extracted = await Promise.all(parts.map(async (part) => {
            const label = `${file.name} p${part.startPage}-${part.endPage}`;
            try {
                const headers = await this._extractMemoInvoices(part.content, emailHtml);

                if (!headers.length) {
                    warnings.push(`No payable row found in memo ${label} — skipped.`);
                    return [];
                }

                const attachment = {
                    fileName: this._splitFileName(file.name, part),
                    content: part.content
                };

                return headers.map(header => ({
                    sourceFile: file.name,
                    startPage: part.startPage,
                    endPage: part.endPage,
                    header,
                    attachment
                }));

            } catch (error) {
                console.error(`[processEmail] memo extraction failed for ${label}:`, error);
                warnings.push(`Memo extraction failed for ${label}: ${error.message}`);
                return [];
            }
        }));

        return extracted.flat();
    }

    /** Memo ranges, falling back to "the whole document is one memo". */
    async _resolveMemoPages(file, warnings) {
        let ranges;
        try {
            ranges = await this._getMemoPages(file.content);
        } catch (error) {
            warnings.push(`Could not read memo page ranges for '${file.name}' (${error.message}) — treating it as a single memo.`);
            ranges = null;
        }

        if (!Array.isArray(ranges) || !ranges.length) {
            if (ranges !== null) {
                warnings.push(`No page range reported for memo '${file.name}' — treating it as a single memo.`);
            }
            return [{ startPage: 1, endPage: await this._pageCountOrOne(file) }];
        }
        return ranges;
    }

    /**
     * Page count for the "whole document is one invoice" fallback. An encrypted
     * or malformed PDF cannot be counted either; 1 keeps the fallback range
     * valid, and `_splitOrWhole` then processes the file whole anyway.
     */
    async _pageCountOrOne(file) {
        try {
            return await pageCount(file.content);
        } catch (error) {
            if (!(error instanceof UnsplittablePdfError)) throw error;
            return 1;
        }
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
            return [{ startPage: 1, endPage: await this._pageCountOrOne(file) }];
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

    // The LLM plumbing itself lives in srv/lib/ai-client.js, shared with
    // srv/lib/document-classifier.js so there is one model configuration rather
    // than two that can drift. The prompts stay here, in this service.

    async _parseAIJson(text) {
        return ai.parseAIJson(text);
    }

    async _createClient() {
        return ai.createClient();
    }

    async _runPrompt(client, systemPrompt, userPrompt, options) {
        return ai.runPrompt(client, systemPrompt, userPrompt, options);
    }

    async _buildContentItem(fileContent, filename = 'invoice.pdf') {
        return ai.buildContentItem(fileContent, filename);
    }

    async _buildFileItem(files) {
        return ai.buildFileItem(files);
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
                The summary should be concise for AP executive to read. 
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

                -------------------------------------
                EMAIL INSTRUCTIONS OVERRIDE THE DOCUMENT (HIGHEST PRECEDENCE)

                The sender often tells Finance how the invoice must be recorded. Such an
                instruction BEATS whatever the PDF says, for the field it names. Examples:

                - "please use vendor code 20345 for both invoices"
                      -> payeeCode = "20345", even if the PDF shows a different code,
                         and even if the PDF shows no code at all
                - "please use GL account 12345"
                      -> EVERY line item gets glAccount = "12345"
                - "kindly post this to cost center 102-05003"
                      -> EVERY line item gets costCenter = "102-05003"

                How to apply them:

                1. Only act on a genuine DIRECTIVE about how to record the payment —
                   "use ...", "please use ...", "post to ...", "charge to ...",
                   "should be ...", "to be booked under ...". A value merely mentioned
                   in passing is NOT an instruction: "our invoice 12345 is attached",
                   "as per PO 9912", "refer to our quotation 555" change nothing.

                2. Scope it correctly. This PDF is ONE invoice, but the email may cover
                   several attachments:
                   - Phrased generally ("both invoices", "all invoices", "these
                     invoices", "the attached") -> applies to this invoice.
                   - Tied to a specific invoice or vendor ("for the Shell invoice ...",
                     "for ZICO please use ...") -> apply ONLY if that is the invoice in
                     THIS PDF. If it names a different one, IGNORE it entirely.

                3. An instruction about a line-item field (glAccount, costCenter,
                   internalOrder) applies to EVERY line item — unless the email itself
                   breaks it down per item or per amount.

                4. Take the VALUE, not the wording: "GL account 12345" -> "12345";
                   "vendor code is 20345" -> "20345"; "CC 102-05003" -> "102-05003".

                5. The per-field rules below still describe the shape of each value.
                   Where an instructed value conflicts with them, keep the instructed
                   value but strip any surrounding label, quotes or punctuation.

                6. Say nothing, change nothing: if the email gives no instruction for a
                   field, extract that field from the PDF exactly as the rules below
                   describe. NEVER invent an instruction that is not there.

                7. If an instruction changes amounts, sum(lineItems.amount) must still
                   equal totalAmount.

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
                - A vendor code stated in the email OVERRIDES the document, including
                  when the document has none
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

                A posting value stated in the email OVERRIDES the document for EVERY
                line item — see EMAIL INSTRUCTIONS above.

                glAccount:
                - Must contain ONLY digits
                - A G/L account stated in the email wins over the document, and applies
                  to every line item
                - May appear as "GL" or "G/L Account"
                - If not found → null

                costCenter:
                - Must match regex: \\d{3}-\\d{5}
                - Example: "102-05003" or "108-02600"
                - A cost center stated in the email wins over the document, and applies
                  to every line item
                - May appear as "CC"  or "Cost Center"
                - If not found → null

                internalOrder:
                - Must match regex: [A-Z]{3}\\d{3}-\\d{3}
                - Example: "PTR121-115" or "PTR121-102"
                - An internal order stated in the email wins over the document, and
                  applies to every line item
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

    // ------------------------------------------------------------------
    // Payment memos
    //
    // The same two stages as above with the opposite reading rule: one appendix
    // TABLE ROW is one invoice, and the covering memo only supplies the context
    // the rows do not repeat. Kept as separate prompts — folding these rules
    // into the invoice prompts above makes both worse.
    //
    // The output shape is identical (`InvoiceHeader` with `lineItems`), so
    // srv/lib/invoice-writer.js persists memo rows and ordinary invoices
    // through the same mapping.
    // ------------------------------------------------------------------

    /**
     * Ranges for a memo. Unlike an invoice PDF, the covering memo page must stay
     * with its appendices: it carries the reference number, date, GL code, cost
     * centre and currency that the rows never repeat. So the natural answer here
     * is usually a single range spanning the whole document.
     *
     * @param {string} fileContent base64 PDF
     * @returns {Promise<Array<{startPage:number,endPage:number}>>}
     */
    async _getMemoPages(fileContent) {
        const userContent = [
            await this._buildContentItem(fileContent, 'memo.pdf'),
            {
                type: 'text',
                text:
                    `
                This PDF contains one or more PAYMENT MEMOS: a covering memo that instructs a
                payment, together with the appendix / schedule tables listing the individual
                payees. Identify the page range of each MEMO.

                Rules:
                - A covering memo AND all of its appendix / schedule pages form ONE SINGLE
                  RANGE covering the whole set, however many pages that is.
                - Do NOT emit one range per appendix page.
                - Do NOT emit one range per table row. The rows are extracted later, from
                  this single range.
                - Do NOT leave out the covering memo page. It carries the reference number,
                  date, GL code, cost centre and currency that the appendix rows rely on.
                - Start a new range ONLY when a genuinely DIFFERENT memo begins — a new
                  covering memo with its own reference number. A document containing a
                  single memo therefore yields exactly ONE range.

                Page numbering rules:
                - Pages are numbered from 1 (the first page of the PDF is page 1).
                - Ranges are inclusive: startPage and endPage are both part of the memo.
                - A single-page memo has startPage equal to endPage.
                - Ranges must NOT overlap, and must be in ascending page order.

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
            `You are an expert at reading payment memos and disbursement schedules.`,
            userContent
        );

        return this._parseAIJson(response);
    }

    /**
     * One invoice per payable row.
     *
     * @param {string} memoContent  base64 PDF of one memo (cover page + appendices)
     * @param {string} emailContent the email body as text/HTML, already decoded
     * @returns {Promise<object[]>} InvoiceHeader-shaped objects
     */
    async _extractMemoInvoices(memoContent, emailContent) {
        const userContent = [
            await this._buildContentItem(memoContent, 'memo.pdf'),
            {
                type: 'text',
                text:
                    `
                You will be given:
                1. The content of a PAYMENT MEMO PDF file (base64 encoded).
                2. The content of an email.

                Email content:
                ${emailContent ?? ''}

                A payment memo is a covering memo / payment instruction / disbursement
                schedule that instructs payment to MANY payees, with one or more appendix
                or schedule TABLES listing them.

                -------------------------------------
                THE CORE RULE: ONE TABLE ROW = ONE INVOICE

                Emit ONE invoice object PER PAYABLE ROW, across ALL appendix tables in the
                document, in document order. Ten rows spread over four appendices means TEN
                invoice objects.

                - Never merge rows, and never emit a single combined "grand total" invoice.
                - Rows that are totals rather than payees ("GRAND TOTAL", subtotal rows, and
                  the memo's own per-appendix summary table on the covering page) are NOT
                  invoices. Skip them — use them only to check your arithmetic.
                - The covering memo page itself is NOT an invoice. It is context.

                -------------------------------------
                WHERE VALUES COME FROM

                Each invoice draws on three places, in this order of precedence:

                1. THE EMAIL — an instruction from the sender about how to record the
                   payment. HIGHEST precedence: it beats both the row and the memo.
                2. THE ROW   — the appendix table row this invoice is built from.
                3. THE MEMO  — the covering memo page, shared by every row.

                Between the row and the memo, the ROW always wins; the memo supplies only
                what the row lacks. Never take a value from a DIFFERENT row.

                EMAIL INSTRUCTIONS, in detail:

                The sender may tell Finance how the memo must be posted, e.g.
                "please use GL account 12345" -> EVERY line item of EVERY row gets
                glAccount = "12345", overriding both the row annotation and the memo's
                own GL code. Likewise for cost center, internal order or vendor code.

                - Only act on a genuine DIRECTIVE ("use ...", "please use ...",
                  "post to ...", "charge to ...", "should be ..."). A value merely
                  mentioned in passing is NOT an instruction.
                - An instruction phrased generally ("all payees", "every row", "this
                  memo", "the attached") applies to EVERY invoice extracted here.
                - An instruction naming ONE payee, scholar code or appendix applies ONLY
                  to that row; every other row keeps its own value.
                - Take the VALUE, not the wording: "GL account 12345" -> "12345".
                - If the email says nothing about a field, use the row/memo rules below
                  exactly as written. NEVER invent an instruction that is not there.

                -------------------------------------
                Output Format (Strict JSON ONLY — No explanation):
                {
                    "invoices": [
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
                    ]
                }

                Follow below rules for each field:

                -------------------------------------
                HEADER FIELDS RULES:

                payeeCode:
                - The scheme / scholar / staff / claimant code printed on the ROW
                - It is normally ALPHANUMERIC (e.g. "SS102-OS0305") — accept it as-is,
                  do not reject it for being non-numeric and do not strip its letters
                - If the row instead shows a numeric vendor code, use that
                - If not found → null

                payeeName:
                - The person or party being paid on this ROW (the student / claimant /
                  beneficiary)
                - NOT the organisation issuing the memo, NOT the university, NOT the bank
                - If not found → null

                payeeAccountNumber:
                - The ROW's own bank account number
                - Rows often show several numbers together (sort code / routing / account
                  number / IBAN / SWIFT). Take the ACCOUNT NUMBER, or the IBAN if given.
                  Do NOT take the sort/routing code and do NOT take the SWIFT/BIC code.
                - If not found → null

                invoiceNumber:
                - Every row shares the memo's reference number, which alone would make the
                  invoices indistinguishable. So build it as:
                      "<memo reference> - <payeeCode>"
                  e.g. "PNB/ED/2025 (411) SP - SS102-OS0305"
                - The memo reference is the covering memo's "Reference" field
                - If the row has no payee code, use appendix and row position instead,
                  e.g. "PNB/ED/2025 (411) SP - A2-04" (appendix 2, row 4)
                - Keep the whole value at or under 60 characters; if it would be longer,
                  shorten the memo reference part, never the code part
                - If no reference exists at all → null

                invoiceDate:
                - The MEMO's own date (its "Date:" line), the same value for every row
                - Do NOT use the due date, the "payment by" date, or a received stamp
                - Convert to ISO format: YYYY-MM-DD
                - If not found → null

                totalAmount:
                - The ROW's own total (its "Total" column)
                - NEVER the appendix grand total and NEVER the memo grand total
                - Must be numeric (no currency symbols, no thousands separators)
                - If not found → null

                currency:
                - Currency code (e.g., MYR, USD, SGD)
                - Usually stated once, on the memo or in the table column headers
                  (e.g. "Total (USD)") — apply it to every row
                - If a symbol is found (e.g., RM), map to ISO code if possible
                - If not found → null

                taxAmount:
                - Memo rows rarely carry tax
                - Numeric only
                - If the row shows none → null

                -------------------------------------
                LINE ITEM RULES:

                Each invoice must contain at least one item. Line items are not goods or
                services — they are the posting details telling Finance which G/L account,
                cost center and internal order to post to.

                - EXTRACTION LOGIC (STRICT ORDER):

                1. DEFAULT: a row is a SINGLE-line posting.
                - Emit ONE item with item.amount = the row's totalAmount

                2. SPLIT into several items ONLY when the row's amount columns are posted
                   to DIFFERENT G/L accounts (e.g. a subsistence allowance column and a
                   book allowance column annotated with different GLs):
                - One item per NON-ZERO column
                - The items MUST sum to the row's totalAmount

                3. Ignore zero-value columns entirely — they are not line items.

                - Always ensure:
                sum(item.amount) == totalAmount

                glAccount:
                - Must contain ONLY digits
                - Prefer the GL annotated on the ROW. It is often written beside the row as
                  "<gl> - <currency><amount>", e.g. "10102680 - USD6210" — the G/L account
                  is the LEADING DIGIT GROUP, NOT the amount that follows it.
                - Fall back to the memo's GL code (e.g. "GL Code: 50008100") only when the
                  row carries none
                - May appear as "GL" or "G/L Account"
                - If not found → null

                costCenter:
                - Must match regex: \\d{3}-\\d{5}
                - Example: "102-05003" or "108-02600"
                - Normally stated ONCE on the covering memo (e.g. "CC: 102-06010") and
                  applies to every row
                - May appear as "CC" or "Cost Center"
                - If not found → null

                internalOrder:
                - Must match regex: [A-Z]{3}\\d{3}-\\d{3}
                - Example: "PTR121-115" or "PTR121-102"
                - May appear as "IO" or "Internal Order"
                - A scholar / claimant code such as "SS102-OS0305" is NOT an internal
                  order — it does not match the regex and belongs in payeeCode
                - If not found → null

                -------------------------------------
                IMPORTANT CONSTRAINTS:

                Return ONLY a valid JSON object with the single key "invoices".
                Do NOT wrap the response in markdown.
                Do NOT include any explanation, notes, or extra text.
                The first character must be { and the last character must be }.
                Emit EVERY payable row — do not truncate the list, do not summarise it,
                and do not write "..." or a comment in place of the remaining rows.
                `,
            },
        ];

        const client = await this._createClient();

        // The answer scales with the number of payees, not the number of pages:
        // a few dozen rows truncate mid-array at the 8000 default and then fail
        // to parse.
        const maxTokens = Number(process.env.AICORE_MEMO_MAX_TOKENS) || 32000;

        const response = await this._runPrompt(
            client,
            `You are an AI assistant specialized in reading payment memos and disbursement schedules. `
            + `Every payable row of the appendix tables is a separate invoice.`,
            userContent,
            { maxTokens }
        );

        return this._normalizeMemoInvoices(await this._parseAIJson(response));
    }

    /**
     * Normalize the memo extraction response into a list of headers. The prompt
     * is told to answer `{ invoices: [...] }`; a bare array or a lone object
     * still reads correctly, which keeps one odd answer from costing the whole memo.
     */
    _normalizeMemoInvoices(parsed) {
        const list = Array.isArray(parsed) ? parsed
            : Array.isArray(parsed?.invoices) ? parsed.invoices
                : parsed ? [parsed]
                    : [];

        return list.filter(header => header && typeof header === 'object');
    }
};