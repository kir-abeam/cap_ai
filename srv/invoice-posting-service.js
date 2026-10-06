const cds = require('@sap/cds');

const invoiceWriter = require('./lib/invoice-writer');
const journalEntry = require('./lib/journal-entry');

// TODO: temporary hard-coded posting defaults — replace with real values.
// Used only when the invoice itself has no value and the env var is unset.
// Empty tax code = tax is posted gross inside the G/L lines (with a warning).
const DEFAULT_COMPANY_CODE = '1000';
const DEFAULT_TAX_CODE = '';

/**
 * Verify = post. Pending invoice -> FI vendor invoice in S/4 -> Verified.
 *
 *   read invoice (+items) -> guard -> SOAP Journal Entry Post -> write back
 *   VerificationStatus 'V' + AccountingDocument / FiscalYear / PostingMessage
 *   in one PATCH.
 *
 * A verified invoice is locked, so it must only become Verified once S/4 has
 * accepted it: any guard or posting error leaves it Pending (and editable) and
 * returns the reasons, so the reviewer can fix the data and press Verify again.
 *
 * Which backend is read and written follows invoiceWriter.writeTarget(); on the
 * 'local' mock nothing is posted — a fake document number is written so the UI
 * flow can be exercised under plain `cds watch`.
 */
module.exports = class InvoicePostingService extends cds.ApplicationService {

    async init() {

        this.on('verifyInvoice', async (req) => {
            const { invoiceUUID } = req.data;
            if (!invoiceUUID) return req.error(400, 'invoiceUUID is required.');

            try {
                return await this._verifyInvoice(req, invoiceUUID);
            } catch (error) {
                console.error('[invoice-posting]', error);
                req.error(error.status || 500, error.message);
            }
        });

        return super.init();
    }

    async _verifyInvoice(req, invoiceUUID) {
        const invoice = await invoiceWriter.readInvoice(invoiceUUID);
        if (!invoice) throw this._fail(404, `Invoice ${invoiceUUID} not found.`);

        const target = invoiceWriter.writeTarget();

        // Repair: posted earlier, but the status write-back never landed. Never
        // post twice — just finish the verification.
        if (invoice.AccountingDocument && invoice.VerificationStatus === 'P') {
            await this._writeBack(invoice, {}, { VerificationStatus: 'V' });
            return {
                accountingDocument: invoice.AccountingDocument,
                fiscalYear: invoice.FiscalYear,
                companyCode: invoice.CompanyCode,
                target,
                verificationStatus: 'V',
                messages: [{ severity: 'info', text: 'Already posted earlier; the invoice is now marked Verified.' }]
            };
        }

        const items = invoice._Item || [];
        this._guard(invoice, items);

        const companyCode = invoice.CompanyCode || process.env.S4_DEFAULT_COMPANY_CODE || DEFAULT_COMPANY_CODE;
        const postingDate = invoice.PostingDate || new Date().toISOString().slice(0, 10);

        const result = target === 's4'
            ? await this._postToS4(req, invoice, items, companyCode, postingDate)
            : this._postMock(companyCode);

        const text = `Posted as ${result.accountingDocument}/${result.fiscalYear}` +
            (result.companyCode ? ` in company code ${result.companyCode}` : '');
        await this._writeBack(invoice, result, {
            VerificationStatus: 'V',
            AccountingDocument: result.accountingDocument,
            FiscalYear: result.fiscalYear,
            PostingMessage: text.slice(0, 255)
        });
        return { ...result, target, verificationStatus: 'V' };
    }

    /** Refuse anything that must not, or cannot, reach FI. */
    _guard(invoice, items) {
        if (invoice.AccountingDocument) {
            throw this._fail(409, `Invoice already posted as accounting document ${invoice.AccountingDocument}` +
                (invoice.FiscalYear ? `/${invoice.FiscalYear}` : '') + '.');
        }
        if (invoice.VerificationStatus !== 'P') {
            throw this._fail(400, 'Only Pending invoices can be verified.');
        }
        if (!invoice.VendorCode) throw this._fail(400, 'Vendor code is missing.');
        if (!invoice.Currency) throw this._fail(400, 'Currency is missing.');
        if (!(Number(invoice.TotalAmount) > 0)) throw this._fail(400, 'Total amount must be greater than zero.');
        if (!items.length) throw this._fail(400, 'The invoice has no line items to post.');

        const missingGL = items.filter(i => !i.GLAccount).length;
        if (missingGL) throw this._fail(400, `${missingGL} line item(s) have no G/L account.`);

        // Line items carry gross amounts (sum == TotalAmount, per the extraction prompt).
        const sum = items.reduce((s, i) => s + Number(i.Amount || 0), 0);
        if (Math.abs(sum - Number(invoice.TotalAmount)) > 0.005) {
            throw this._fail(400, `Line items sum to ${sum.toFixed(2)} but the total is ` +
                `${Number(invoice.TotalAmount).toFixed(2)} ${invoice.Currency}.`);
        }
    }

    async _postToS4(req, invoice, items, companyCode, postingDate) {
        if (!companyCode) {
            throw this._fail(400, 'Company code is missing: set it on the invoice or configure S4_DEFAULT_COMPANY_CODE.');
        }
        // The duplicate guard and the write-back both depend on this field. Until
        // ZUI_INVOICE_REVIEW_O4 exposes it, nothing would stop a second post of
        // the same invoice — refuse unless explicitly allowed for testing.
        if (!('AccountingDocument' in invoice) && process.env.S4_POSTING_ALLOW_NO_WRITEBACK !== 'true') {
            throw this._fail(500, 'ZUI_INVOICE_REVIEW_O4 does not expose AccountingDocument yet, so a posted ' +
                'invoice could be posted twice. Extend the S/4 service first ' +
                '(or set S4_POSTING_ALLOW_NO_WRITEBACK=true for testing).');
        }
        if (!journalEntry.isConfigured()) {
            throw this._fail(500, 'S4_JOURNAL_ENTRY is not configured (destination ABMY_JOURNAL_ENTRY / ' +
                'user-provided service under the s4 profile).');
        }

        const { xml, warnings } = journalEntry.buildEnvelope({
            invoice,
            items,
            companyCode,
            postingDate,
            documentType: process.env.S4_POSTING_DOC_TYPE || 'KR',
            taxCode: invoice.TaxCode || process.env.S4_DEFAULT_TAX_CODE || DEFAULT_TAX_CODE,
            // USNAM is 12 chars; a BTP user id is an email, so keep the local part.
            createdBy: process.env.S4_POSTING_CREATED_BY || String(req.user?.id || '').split('@')[0].toUpperCase(),
            messageId: cds.utils.uuid()
        });

        const parsed = journalEntry.parseResponse(await journalEntry.send(xml));
        const messages = [...warnings.map(text => ({ severity: 'warning', text })), ...parsed.messages];

        if (!parsed.ok) {
            const errors = messages.filter(m => m.severity === 'error').map(m => m.text);
            throw this._fail(400, 'S/4 rejected the posting: ' +
                (errors.length ? errors.join(' | ') : messages.map(m => m.text).join(' | ') || 'no reason given'));
        }

        return {
            accountingDocument: parsed.accountingDocument,
            fiscalYear: parsed.fiscalYear,
            companyCode: parsed.companyCode || companyCode,
            messages
        };
    }

    /** Local mock: nothing leaves the process. */
    _postMock(companyCode) {
        const accountingDocument = '19' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
        return {
            accountingDocument,
            fiscalYear: String(new Date().getFullYear()),
            companyCode: companyCode || '',
            messages: [{ severity: 'info', text: 'Mock posting — no document was created in S/4.' }]
        };
    }

    /**
     * PATCH the result onto the invoice (retried once). After a successful post
     * a failure here is the dangerous case: the invoice would still look Pending
     * and a second Verify would post it again — so fail loudly with the document
     * number instead of quietly.
     */
    async _writeBack(invoice, result, patch) {
        const keys = { emailUUID: invoice.EmailUUID, invoiceUUID: invoice.InvoiceUUID };
        let lastError;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                return await invoiceWriter.updateInvoice(keys, patch);
            } catch (err) {
                lastError = err;
                console.error(`[invoice-posting] write-back attempt ${attempt} for invoice ` +
                    `${invoice.InvoiceUUID} failed:`, err.message);
            }
        }
        if (!result.accountingDocument) throw lastError;   // repair path: nothing new was posted
        console.error(`[invoice-posting] invoice ${invoice.InvoiceUUID} was POSTED as ` +
            `${result.accountingDocument}/${result.fiscalYear} but could not be marked Verified — do not verify it again.`);
        throw this._fail(500, `Posted in S/4 as ${result.accountingDocument}/${result.fiscalYear}, but the invoice ` +
            `could not be updated (${lastError.message}). Do NOT verify it again — contact your administrator.`);
    }

    _fail(status, message) {
        return Object.assign(new Error(message), { status });
    }
};
