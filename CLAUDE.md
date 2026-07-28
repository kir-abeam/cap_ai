# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`ai_cap` is a SAP Cloud Application Programming (CAP) Node.js project with two independent parts:

1. **`DocumentProcessingService`** (`/document-processing-service`) — AI extraction of invoice data from PDFs via LLMs on SAP AI Core:
   - **`processEmail(files, email)` — the primary entry point**: runs the whole pipeline in one call and **persists** the result. See "processEmail pipeline" below.
   - `summarizeEmail(files, email)` — HTML summary + the names of the attachments that contain invoices, returns `SummaryOutput`.
   - `classifyDocument(fileContent)` — which of the two prompt sets below a file will be routed to, returns `DocumentClassification` (`'invoice'` | `'payment_memo'`). See "Document routing" below.

   **Invoice prompts** (one document, or one page range in it, = one invoice):
   - `getInvoicePages(fileContent)` — identifies page ranges in a (possibly multi-invoice) PDF, returns `many PageRange` (**1-based, inclusive, non-overlapping** — the splitter depends on it).
   - `extractInvoice(invoiceContent, emailContent)` — extracts a structured `InvoiceHeader` (with `lineItems`) from a PDF plus email text.

   **Payment-memo prompts** (one appendix table row = one invoice):
   - `getMemoPages(fileContent)` — returns `many PageRange`, same contract as `getInvoicePages` but memo-aware (the cover page stays with its appendices).
   - `extractMemoInvoices(memoContent, emailContent)` — returns **`many InvoiceHeader`**, one per payable row.

   The two sets are **separate actions on the same service, sharing the same `InvoiceHeader`/`PageRange` types** — `invoice-writer.js` persists their output identically and only the prompts differ. They are kept apart because folding memo rules into the invoice prompts makes both worse. The single-stage actions are stateless and exist for debugging one step at a time; `processEmail` composes them. All PDF/text inputs are `LargeString` (base64 PDF / base64 HTML). Return types are CDS `type`s in `srv/DocumentProcessingService.cds`.

2. **`InvoiceReviewService`** (`/invoice-review`) — a persisted, Fiori-facing service backing a **Fiori Elements List Report + Object Page** app (`app/invoicereview/`) for reviewing and verifying extracted invoices. See "Invoice Review app" below.

## Commands

- `npm start` — runs `cds-serve` (production-style serve).
- `npm run hybrid` — runs `cds watch --profile hybrid`; this is the primary dev loop. The `hybrid` profile binds to a real SAP AI Core instance via `.cdsrc-private.json` (gitignored), so it needs Cloud Foundry credentials for the `default_aicore` service in the `ABeam Consulting Ltd.` org / `dev` space.
- Manual testing: use `test/request.http` (REST Client). Every action accepts an empty body `{}` and falls back to bundled sample data (see below), so you can exercise the AI path without supplying a PDF.

- Fiori app (Invoice Review): run `cds watch` (or `cds serve --in-memory`), then open `http://localhost:4004/invoicereview/webapp/index.html`. SQLite auto-deploys `db/schema.cds` and loads the CSV seed under `db/data/`.

There is no test runner, linter, or build step configured. `@cap-js/sqlite` (dev) provides the in-memory persistence for `InvoiceReviewService` and for `processEmail`'s local write target.

`cds.server.body_parser.limit` is raised to `50mb` in `package.json` — `processEmail` carries base64 PDF attachments and CAP's 100kb default rejects any real invoice with a 413.

## processEmail pipeline

`processEmail(files, email)` is the single call that turns a received email into reviewable invoices. Implemented by `_processEmail` in `srv/DocumentProcessingService.js`:

1. **Summarize** — `_summarizeEmail` returns the HTML summary and `invoiceFileNames`.
2. **Match** — those names are resolved back to the uploaded `files` (case-insensitive basename). Nothing matches → process *all* attachments and warn.
3. **Route** — `_classifyFile` per matched file decides which service reads it (see "Document routing"). A classification failure warns and falls through to the invoice path.
4. **Page ranges** — `_getInvoicePages` (invoice) or `_getMemoPages` (memo) per file. Empty or unparseable → fall back to `1..pageCount` and warn.
5. **Split** — `srv/lib/pdf-split.js` (`pdf-lib`) cuts one standalone PDF per range. Ranges are clamped to the document; degenerate ones are skipped rather than throwing. A PDF pdf-lib cannot open is processed **whole** instead of being lost — see "Encrypted and signed PDFs" below.
6. **Extract** — `_processInvoiceFile` → `_extractInvoice` **one invoice per part**; `_processMemoFile` → `_extractMemoInvoices` **many invoices per part** (`Promise.all` within a file either way).
7. **Persist** — `srv/lib/invoice-writer.js` creates `Email` + `Invoice` + `InvoiceItem` + `Attachment` (the split PDF), status `P`.

**Failures degrade into `warnings`, not errors**: a bad attachment or a failed extraction costs only that file/invoice; the email and everything else still get created. The `ProcessEmailResult` carries `emailUUID`, `target`, `summary`, the per-invoice `startPage/endPage/header`, and `warnings`.

### Encrypted and signed PDFs (`srv/lib/pdf-split.js`)

**`pdf-lib` implements no decryption at all**, and digitally signed invoices are routinely AES-encrypted (`/Filter /Standard`, `/V 4`, `/CFM /AESV2`) — e.g. a Shell invoice signed via *Acrobat Sign Certify Document Service*. `ignoreEncryption: true` does **not** make those readable; it only suppresses pdf-lib's "document is encrypted" guard, after which pdf-lib parses the still-ciphertext object streams as PDF syntax. The result is `Trying to parse invalid object` / `Invalid object ref: 48 0 R` noise followed by `Expected instance of PDFDict, but got instance of undefined` from inside `PDFCatalog.Pages` — an error that names neither encryption nor the file. That option is therefore **not** used.

Instead `_load` checks for `/Encrypt` up front (content streams are compressed, so a plaintext match is reliable) and throws a typed **`UnsplittablePdfError`**. Splitting such a file would be wrong even if it parsed: copying encrypted streams into a new unencrypted PDF yields an attachment that will not render.

`_splitOrWhole` in the service catches that error and **processes the file whole**: the LLM reads encrypted PDFs perfectly well, so the only capability lost is page splitting. The invoice is still extracted and the `Attachment` stores the **original bytes, byte-for-byte** (signature intact, opens in any viewer). A warning records it, and a second warning fires when the model reported more than one range — those invoices cannot be separated and get extracted together. The reported `startPage/endPage` is the span of the model's ranges, since the page count itself is unreadable.

Note `instanceof pdfLib.EncryptedPDFError` is **unreliable** — pdf-lib's ES5-compiled error subclasses lose their prototype chain (`err.name` is plain `'Error'`), which is why encryption is detected directly rather than by catching that class.

## Document routing (`srv/lib/document-classifier.js`)

Two document families need **opposite** reading rules, so rather than one prompt trying to cover both, a cheap classification picks the prompt set up front:

| | reading rule | actions |
|---|---|---|
| `invoice` | one document (or one page range in it) = one invoice | `getInvoicePages` + `extractInvoice` |
| `payment_memo` | one appendix **table row** = one invoice | `getMemoPages` + `extractMemoInvoices` |

**The deciding question is where a payment's detail lives, not whether a covering memo is present.** This is the subtle part, and getting it wrong silently reroutes working documents:

- `srv/Invoice.pdf` (the bundled fallback) is a PNB covering memo naming two payees, **followed by their two real invoices** → `invoice`. The memo is only a transmittal; each attached invoice is read on its own, exactly as before.
- A scholarship/allowance memo whose payees exist **only as appendix rows**, with no invoice document for any of them → `payment_memo`.

An earlier version of the prompt asked only "how many payees?" and misrouted `srv/Invoice.pdf` to the memo path at 0.9 confidence. The rule is now ordered: *contains a real invoice document → `invoice`; else payees only as table rows → `payment_memo`; else → `invoice`.*

Only the **first `PEEK_PAGES` pages** (default 5, `AICORE_CLASSIFY_PEEK_PAGES`) are sent — the answer hinges on what follows the cover page, and a long schedule shouldn't cost a full read just to be labelled. Too few pages and a multi-page cover hides the invoices behind it. Anything other than the two known labels, or an outright failure, **degrades to `invoice`** — the long-standing path.

### Payment memos (`_getMemoPages` / `_extractMemoInvoices`)

Kept as their own actions precisely so the invoice prompts stay untouched. Their rules, all of which differ from the invoice prompts:

- **Page ranges**: a covering memo and all its appendix pages are **one range**. The cover page is never dropped as a "cover letter" — it carries the reference number, date, GL code, cost centre and currency that the rows never repeat.
- **Extraction**: one invoice per row across all appendices; GRAND TOTAL / subtotal rows and the cover's own summary table are skipped. Row-level values beat memo-level ones, and a value is never taken from a different row.
- **Field rules**: `invoiceNumber` = `"<memo reference> - <payeeCode>"` (rows all share the memo's reference, so the bare reference would make them indistinguishable; falls back to `"<ref> - A2-04"`, appendix + row); `payeeCode` accepts an **alphanumeric** scholar/claimant code (`SS102-OS0305`) — the digits-only vendor-code rule is invoice-only; `payeeAccountNumber` takes the account/IBAN, not the sort or SWIFT code; `invoiceDate` = the memo's date, not the due date; `totalAmount` = the row's own total, never a grand total; `glAccount` = the row annotation (`"10102680 - USD6210"` → the leading digit group) falling back to the memo's GL; `costCenter` = the memo's.
- Every invoice from one memo gets **its own Attachment row holding the same split PDF** — a single row's page is not evidence without the covering memo.
- `max_tokens` is **32000** (`AICORE_MEMO_MAX_TOKENS`): the answer scales with payee count, and the 8000 default truncates a few dozen rows mid-array into a parse failure.
- `_normalizeMemoInvoices` accepts `{invoices:[…]}` (what the prompt asks for), a bare array, or a lone object, so one oddly-shaped answer doesn't cost the whole memo.

### Where it writes (`srv/lib/invoice-writer.js`)

`writeTarget()` picks the backend at runtime — **`s4`** when `cds.env.requires.ZUI_INVOICE_REVIEW_O4` has credentials/binding (i.e. `npm run s4`), **`local`** otherwise. Same test `srv/server.js` uses for the dev proxy. `INVOICE_WRITE_TARGET=local|s4` overrides.

- **local** — plain `INSERT`s into the `abeam.invoicereview` tables inside one `db.tx`. Draft is a UI concern; these are the active rows, exactly like the CSV seed.
- **s4** — the draft-enabled RAP service takes **no deep insert**, so the graph is created node by node inside one Email draft: `POST Email` (creates the draft) → `POST Email(…,IsActiveEntity=false)/_Invoice` → `…/_Item` and `…/_Attachment` (`Content` as a **base64 string**, S/4 types it `Edm.Binary`) → `POST …/<ns>.Activate`. Any failure after the draft exists triggers `<ns>.Discard` so no orphan draft locks the email. `<ns>` is hard-coded `com.sap.gateway.srvd_a2x.zui_invoice_review_o4.v0001` — the saved EDMX carries **no** `Common.DraftRoot` annotation to read action names from (unlike live `$metadata`, which is what `VerificationHandler.js` uses client-side).

**Null-valued properties are stripped from S/4 payloads** (`compact()` in `invoice-writer.js`). Almost every property in the EDMX is `Nullable="false"` — ABAP fields have initial values, not nulls — so an explicit `null` earns `400 Property '<name>' at offset '<n>' has invalid value 'null'`. Omitting it lets RAP apply the initial value (`''`/`0`). The local backend keeps the nulls, so "not found" stays distinguishable from an empty string there; on S/4 that distinction does not exist.

**Every S/4 request must set `content-type: application/json` explicitly** (`_send` in `invoice-writer.js` does). CAP's remote client only adds that header when `requestConfig.data` is a plain object (`libx/_runtime/remote/utils/query.js`); otherwise the POST reaches Gateway with no content type, Gateway falls back to XML/Atom parsing and answers **400 "Error while parsing an XML stream"** — an error about *our request body*, not about any XML response. Caller-supplied headers are merged last by `_getHeaders`, so they win. `accept: application/json` is set for the same reason: it keeps error bodies in the shape CAP's client reads (`error.message.value`), so failures surface with S/4's real text instead of a generic one. RAP is also free to assign its own keys, so `_writeS4` continues from the key S/4 echoes back rather than the generated one.

### Field mapping and the base64 convention

Extraction is camelCase, persistence is PascalCase and identical on both backends: `invoiceNumber→DocumentNumber`, `invoiceDate→DocumentDate`, `payee*→Vendor*`, `lineItems→_Item`. Values pass through `str(max)/num/isoDate` coercers — the prompt returns `""` for "not found" (must become `null`), amounts like `"RM292,680.00"`, and unbounded strings that would blow S/4's `MaxLength`.

**`Email.EmailBodyHtml` and `Email.Summary` are stored base64-encoded**, matching the CSV seed and both Fiori formatters (`EmailBodyFormatter.js` / `AISummaryFormatter.js` `atob` before rendering into the iframe `srcdoc`). So `email.content` is stored **verbatim** (it already arrives base64) and the LLM's plain-HTML summary is **encoded** on the way in. Decoding happens only to build prompt input — never on the write path.

## Invoice Review app

An end-to-end review/verification UI built as **Fiori Elements** (List Report + two Object Pages). Currently runs on **local mock data** but is modeled as the contract a future **single combined S/4HANA OData service** will implement (email header + invoice children; attachments map to an S/4 custom table XSTRING column at the invoice level). See `.claude/plans/i-want-to-create-fuzzy-turing.md` for the full design and the mock→S/4 migration path.

- **One email carries many invoices.** The model is split into two entities: `Emails` (parent) → `Invoices` (child) via a **composition** (`Emails.invoices`, backlinked by `Invoices.email` → FK `email_ID`). **`Emails` is the draft root**; invoices are contained **draft-node sub-object-pages**, edited/verified within the email draft. (An earlier attempt made Email read-only with each invoice an independent draft root via an *association* — FE won't let an invoice reached from a read-only parent enter its draft, breaking both edit and navigation, so it's a **composition with Email as the draft root**.)
- **Model** (`db/schema.cds`, namespace `abeam.invoicereview`):
  - `Emails`: email metadata (`emailSubject/emailSentDate/emailSender/emailBodyHtml`) + `invoices` composition + two **virtual** rollup fields `statusCriticality`/`statusSummary` (an email-level summary of its invoices' statuses; computed in the service, not persisted).
  - `Invoices`: invoice header + `verificationStatus` (code list `VerificationStatuses`: P/V/R with a `criticality` column for FE coloring) + compositions `lineItems` and `attachments` (media entity, `LargeBinary content @Core.MediaType`).
  - Field-name mapping vs. `DocumentProcessingService` types: `documentNumber←invoiceNumber`, `documentDate←invoiceDate`, `vendor*←payee*`.
  - `isEditable : Boolean = verificationStatus.code = 'P'` is a **calculated element** on `Invoices` and the single source of truth for per-invoice editability (locks the invoice sub-page even inside the email draft).
- **Service** (`srv/invoice-review-service.cds` + `.js`): `@odata.draft.enabled Emails` (the **draft root**) + a plain `Invoices` child projection with bound actions `verify()` / `rejectInvoice()`. Only the root carries `@odata.draft.enabled`; the composition children (`Invoices`, `InvoiceLineItems`, `Attachments`) become draft nodes automatically. Note `reject` was renamed to `rejectInvoice` because a plain `reject` action **collides with a base-class method** on `cds.ApplicationService` (label stays "Reject"). An `after('READ', Emails)` handler hydrates the rollup virtual fields (a to-many aggregate can't be a plain CDS calc — criticality = most severe among children); a `cds.once('served')` hook hydrates mock attachment binaries from the sample PDFs in `srv/`.
- **Annotations + the verify lock** (`app/documentprocessing/annotations.cds`, mirrored in `test/invoice-review-annotations.cds`): `Emails` gets the List Report columns + the Email OP facets (email body + invoices table) + `Insert/Delete` disabled (emails aren't user-created); `Invoices` gets the invoice-table columns, header FieldGroup, line-items facet, verify/reject actions, and the lock. The Invoice sub-page becomes read-only after Verify/Reject via `Capabilities.UpdateRestrictions: { Updatable: isEditable }`. **Gotcha:** the flattened form `UpdateRestrictions.Updatable : isEditable` folds to a static `false` — you must use the record form `{ Updatable: isEditable }` to emit a path binding.
- **Navigation**: List Report (`/Emails`) → Email OP (`/Emails`, email body custom section + invoices table) → Invoice sub-Object-Page (`/Emails/invoices`, header + line items + attachments), reached by **contained** navigation with the nested route `Emails({key})/invoices({invoicesKey})`. Edit/Save on the invoice sub-page operate on the (email-scoped) draft; verify/reject and the `isEditable` lock stay per-invoice.
- **Custom FE extensions** (`app/documentprocessing/webapp/ext/`): the email body is rendered on the **Email OP** as an HTML custom section — `EmailBodyFormatter.sanitize` base64-decodes then wraps the email in a sandboxed `<iframe srcdoc>` (loaded via `core:require`, since a dotted formatter string resolves globally and an AMD module has no global). The Attachments button on the **Invoice OP** opens a dialog listing that invoice's attachments. Because `Invoices` is draft-enabled, media/entity keys **must include `IsActiveEntity`** — e.g. `Attachments(ID=<guid>,IsActiveEntity=true)/content`.
- **App scaffolding**: hand-authored (no `@sap/generator-fiori` installed) and served statically by `cds watch`; UI5 bootstraps from the CDN in `index.html`.

## S/4HANA integration (App → S/4 direct, via a dev pass-through)

The invoice-review app runs against **either** the local CAP mock (default `cds watch`) **or** the real draft-enabled S/4 OData service (`cds watch --profile s4`). It is **not** a CAP delegation/proxy — the browser talks to S/4 **directly**; CAP only forwards the request in dev. Switching backends is a manifest edit: `mainService.uri` + `annotations` (see below). The entity/field names are identical (the CAP mock mirrors S/4 1:1), so nothing else changes.

- **External service metadata**: `srv/external/ZUI_INVOICE_REVIEW_O4.edmx` is the source of record (the S/4 metadata); `srv/external/ZUI_INVOICE_REVIEW_O4.cds` is the hand-authored consumption model. Wired in `package.json` `cds.requires.ZUI_INVOICE_REVIEW_O4` (`kind: odata`, `model` always loaded) — used to **resolve the CF service binding** (S/4 url + basic-auth creds) under the **`s4` profile** (`npm run s4`), a CF **user-provided service** `ABMY_INVOICE_REVIEW` referenced in `.cdsrc-private.json`, so **no secret is stored in any local file** (resolved from CF at runtime; requires `cf login`). It is **not** consumed as a CAP remote service at request time.
- **The dev pass-through** (`srv/server.js`): a `cds.on('bootstrap')` hook mounts `app.use('/sap', …)` that forwards `localhost:4004/sap/...` straight to the real S/4 host, injecting the basic-auth header from the resolved CF binding (so credentials never reach the browser) and honoring `HTTPS_PROXY`/`NO_PROXY`. **Profile-gated**: the hook is a no-op unless `ZUI_INVOICE_REVIEW_O4` has credentials/binding (i.e. `--profile s4`), so the default/mock path is untouched. This is the **only** server-side S/4 code — there is no CQN remapping or name translation layer.
- **Manifest switch** (`app/documentprocessing/webapp/manifest.json`): mock = `uri:/invoice-review/` + `annotations:[]` (FE annotations come from the CAP service metadata, i.e. `app/documentprocessing/annotations.cds`); live S/4 = `uri:/sap/opu/odata4/.../zui_invoice_review_o4/0001/` + `annotations:["localAnnotations"]` (FE annotations come from `app/documentprocessing/webapp/annotations/annotations.xml`). Keep `annotations.cds` (mock) and `annotations.xml` (S/4) **in sync**.
- **No CAP calc engine on the S/4 path** → anything the mock derives via CAP calculated elements must be reproduced in `annotations.xml` (static, S/4-path-only) or client-side:
  - `VerificationStatus` read-only in edit mode: mock uses `@Common.FieldControl` → the `VerificationStatusFC` calc field; S/4 uses a **static** `Common.FieldControl ReadOnly` in `annotations.xml` (EDMX keeps static field control; the CAP compiler drops it, which is why the mock needs the path form).
  - `VerificationStatus` shown as Pending/Verified/Rejected: mock uses `@Common.Text` → the `VerificationStatusText` calc field; S/4 uses a `Common.Text` **conditional expression** (`If/Eq` on the code) + `TextArrangement TextOnly` in `annotations.xml`.
  - **Edit lock** (a Verified/Rejected invoice is not editable): mock uses `@Capabilities.UpdateRestrictions.Updatable = IsEditable` (a CAP boolean calc field). S/4 exposes no such boolean and `UpdateRestrictions.Updatable` needs a real property path, so the lock is done **client-side** by `app/documentprocessing/webapp/ext/InvoiceEditLock.controller.js` — an FE `ControllerExtension` (registered in the manifest on `sap.fe.templates.ObjectPage.ObjectPageController`) that, on the Invoice OP only, binds the standard Edit button's `visible` to `VerificationStatus === 'P'` (needs `targetType:'any'` so the raw code isn't coerced to Boolean). It is a harmless no-op on the mock path (agrees with the annotation lock).
- **Verify/Reject work on both backends**: `app/documentprocessing/webapp/ext/VerificationHandler.js` drives the S/4/CAP **Email-rooted draft flow directly from the client** — read the Edit/Activate action names off the `Common.DraftRoot` annotation, then **Edit (owning Email) → PATCH the invoice draft node's `VerificationStatus` → Activate → refresh**. The read-only field control is a UI hint only and does not block this programmatic PATCH.

## Architecture notes

- **LLM access goes through `@sap-ai-sdk/orchestration`'s `OrchestrationClient`** (`srv/lib/ai-client.js`, which both document services share so the model configuration cannot drift; `DocumentProcessingService`'s `_createClient`/`_runPrompt`/`_buildContentItem`/`_parseAIJson` are thin delegates kept for its existing call sites). `ai-client.js` is deliberately **prompt-free** — every prompt lives with the service that owns it. Not the `@sap-ai-sdk/langchain` package listed in `package.json`. The orchestration package is resolved transitively; if you add direct usage, add it to `package.json` explicitly.
- **Model and resource group are env-configurable**: `AICORE_INVOICE_MODEL` (default `anthropic--claude-4.6-sonnet`) and `AICORE_RESOURCE_GROUP` (default `abmy-project`). These target deployments configured in SAP AI Core, not the public Anthropic API — do not swap in raw `claude-*` model IDs or Anthropic SDK calls.
- **PDFs are sent as multimodal content items**: `_buildContentItem` wraps base64 PDF bytes as a `type: 'file'` message part (`data:application/pdf;base64,...`). User prompts are arrays mixing this file item with `type: 'text'` instructions.
- **Prompts demand strict JSON output.** Every response goes through `_parseAIJson`, which strips a markdown fence if present and then `JSON.parse`s — there is no further repair, and a parse failure surfaces as a 500 (single-stage actions) or a warning (inside `processEmail`). The extraction prompt encodes detailed business rules (payee/GL/cost-center/internal-order regexes, line-item summation logic); treat that prompt text as the spec when changing extraction behavior. Its emitted key is `lineItems`, which must keep matching `InvoiceHeader.lineItems` — CAP silently drops the array otherwise.
- **`_runPrompt` defaults to `max_tokens: 8000`** (overridable per call). A low ceiling truncates a multi-line-item extraction or a multi-invoice page-range list mid-JSON, which then fails to parse.
- **Dev fallbacks are hardcoded** in `_processEmailFallbacks` / `_getInvoicePages` / `_extractInvoice`: when an input is empty, the code reads `srv/Invoice.pdf` (pipeline, pages) or `srv/Invoice_3.pdf` (extract) and injects a canned email. These sample PDFs live in `srv/`.
- **Auth**: `xsuaa` is only required under the `[production]` profile (`package.json` `cds.requires`). Dev/hybrid runs are open. `xs-security.json` currently defines no scopes or roles.

## Layout

- `srv/` — the services (`.cds` model + `.js` implementation), the S/4 external model under `srv/external/`, and bundled sample invoice PDFs.
- `srv/lib/` — pipeline helpers with no CAP coupling: `pdf-split.js` (page-range splitting via `pdf-lib`), `invoice-writer.js` (field mapping + the local/S/4 write paths), `ai-client.js` (shared LLM plumbing, no prompts) and `document-classifier.js` (the invoice/payment-memo router).
- `db/` — `schema.cds` (`abeam.invoicereview`), CSV seed under `db/data/`, `undeploy.json` (HANA undeploy allowlist).
- `app/` — the `documentprocessing` Fiori Elements app and the approuter config.
- `test/request.http` — manual HTTP requests against the running service.
