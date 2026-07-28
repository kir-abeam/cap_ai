/**
 * Routes an attachment to the prompts that know how to read it.
 *
 * The two document families need genuinely different instructions, and mixing
 * them into one prompt makes both worse — so instead of one prompt that tries
 * to cover everything, a cheap classification decides up front which set of
 * DocumentProcessingService actions the pipeline runs:
 *
 *   INVOICE      -> getInvoicePages + extractInvoice       (one document = one invoice)
 *   PAYMENT_MEMO -> getMemoPages    + extractMemoInvoices  (one table row = one invoice)
 *
 * Only the first few pages are sent: the distinction is visible immediately
 * (a memo header and appendix tables vs. an invoice's vendor/total block), and
 * a 40-page schedule would otherwise cost a full read just to be labelled.
 */

const ai = require('./ai-client');
const { splitPdf, pageCount } = require('./pdf-split');

const INVOICE = 'invoice';
const PAYMENT_MEMO = 'payment_memo';

/**
 * Pages fed to the classifier. Enough to see past a covering memo to whatever
 * follows it — which is the whole question, since a memo followed by real
 * invoices is an "invoice" and a memo followed by more tables is a "payment_memo".
 * Too few pages and a multi-page cover hides the invoices behind it.
 */
const PEEK_PAGES = Number(process.env.AICORE_CLASSIFY_PEEK_PAGES) || 5;

const SYSTEM_PROMPT =
    'You are a document triage system. You classify payable documents into exactly one category '
    + 'and answer with strict JSON only.';

const INSTRUCTIONS = `
Classify this document into exactly ONE category.

THE ONLY QUESTION THAT MATTERS:
Where does the detail of each payment live — in a real invoice document, or only
in a row of a table?

"invoice"
- The file contains one or more REAL INVOICE DOCUMENTS: a vendor letterhead, an
  invoice number, a bill-to party, a description of goods or services, a total due.
- Choose this even when there are SEVERAL invoices in the file.
- Choose this even when the invoices are preceded by a covering memo, transmittal
  note, routing slip or approval page that instructs payment for them. Such a memo
  is only a wrapper: each attached invoice is read on its own afterwards.
- A covering memo naming two payees, followed by those two payees' actual
  invoices, is "invoice".

"payment_memo"
- A covering memo, payment instruction, disbursement schedule, claim listing,
  allowance batch or payment advice where the payees exist ONLY AS ROWS in
  appendix / schedule TABLES, with NO separate invoice document for any of them
  anywhere in the file.
- Typically shows: a memo header (To / From / Date / Reference / Subject), an
  instruction such as "please initiate payment", a grand total broken down per
  appendix or batch, and tables with one row per person or per claim — each row
  carrying its own name, amount and often its own bank account.
- Typical payees are individuals: scholars, students, staff, claimants.
- The table row IS the only record of that payment. There is nothing else to read.

Deciding rule, in order:
1. Does the file contain at least one real invoice document?      -> "invoice"
2. Otherwise, are the payees listed only as rows of a table?      -> "payment_memo"
3. Otherwise (a single payable document, whatever its layout)     -> "invoice"

Do NOT answer "payment_memo" merely because a covering memo is present, or because
several payees are named on the cover. Answer "payment_memo" only when the appendix
TABLE ROWS are the sole source of each payment's detail.

Output Format (Strict JSON ONLY — No explanation):
{
    "documentType": "invoice" | "payment_memo",
    "confidence": <number between 0 and 1>,
    "reason": "<one short sentence>"
}
`;

/**
 * @param {string} fileContent base64 PDF
 * @returns {Promise<{documentType: string, confidence: number, reason: string}>}
 */
async function classifyDocument(fileContent) {
    const peek = await _firstPages(fileContent);

    const userContent = [
        await ai.buildContentItem(peek),
        { type: 'text', text: INSTRUCTIONS }
    ];

    const client = await ai.createClient();
    const parsed = await ai.parseAIJson(
        await ai.runPrompt(client, SYSTEM_PROMPT, userContent, { maxTokens: 500 }));

    // Anything the model invents that is not one of the two labels is treated as
    // an invoice: that is the long-standing path, so an odd answer degrades to
    // the previous behaviour instead of routing a normal invoice somewhere new.
    const documentType = parsed?.documentType === PAYMENT_MEMO ? PAYMENT_MEMO : INVOICE;

    return {
        documentType,
        confidence: Number(parsed?.confidence) || 0,
        reason: String(parsed?.reason ?? '')
    };
}

/** The first PEEK_PAGES pages, or the whole document when it is shorter. */
async function _firstPages(fileContent) {
    try {
        const total = await pageCount(fileContent);
        if (total <= PEEK_PAGES) return fileContent;

        const [part] = await splitPdf(fileContent, [{ startPage: 1, endPage: PEEK_PAGES }]);
        return part?.content ?? fileContent;
    } catch {
        // A PDF we cannot split is still worth classifying — send it whole.
        return fileContent;
    }
}

module.exports = { classifyDocument, INVOICE, PAYMENT_MEMO };
