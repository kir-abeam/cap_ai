# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`ai_cap` is a SAP Cloud Application Programming (CAP) Node.js project with two independent parts:

1. **`DocumentProcessingService`** (`/document-processing-service`) — AI extraction of invoice data from PDFs via LLMs on SAP AI Core. Action-only, no persistence:
   - `getInvoicePages(fileContent)` — identifies page ranges in a (possibly multi-invoice) PDF, returns `many PageRange`.
   - `extractInvoice(invoiceContent, emailContent, ocrResults)` — extracts a structured `InvoiceHeader` (with `lineItems`) from a PDF plus email text plus existing OCR JSON.

   All inputs are `LargeString` (base64 PDF / plain text / JSON string). Return types are CDS `type`s in `srv/DocumentProcessingService.cds`.

2. **`InvoiceReviewService`** (`/invoice-review`) — a persisted, Fiori-facing service backing a **Fiori Elements List Report + Object Page** app (`app/invoicereview/`) for reviewing and verifying extracted invoices. See "Invoice Review app" below.

## Commands

- `npm start` — runs `cds-serve` (production-style serve).
- `npm run hybrid` — runs `cds watch --profile hybrid`; this is the primary dev loop. The `hybrid` profile binds to a real SAP AI Core instance via `.cdsrc-private.json` (gitignored), so it needs Cloud Foundry credentials for the `default_aicore` service in the `ABeam Consulting Ltd.` org / `dev` space.
- Manual testing: use `test/request.http` (REST Client). Both actions accept an empty body `{}` and fall back to bundled sample data (see below), so you can exercise the AI path without supplying a PDF.

- Fiori app (Invoice Review): run `cds watch` (or `cds serve --in-memory`), then open `http://localhost:4004/invoicereview/webapp/index.html`. SQLite auto-deploys `db/schema.cds` and loads the CSV seed under `db/data/`.

There is no test runner, linter, or build step configured. `@cap-js/sqlite` (dev) provides the in-memory persistence for `InvoiceReviewService`; `DocumentProcessingService` remains action-only.

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

## S/4HANA delegation (App → CAP → S/4)

The invoice-review data can be served either from the local SQLite mock (default) or delegated to the real draft-enabled S/4 OData service — a **proxy**: the app always talks to CAP; CAP translates to S/4.

- **External service**: `srv/external/ZUI_INVOICE_REVIEW_O4.edmx` is the source of record (the S/4 metadata); `srv/external/ZUI_INVOICE_REVIEW_O4.cds` is the hand-authored consumption model (regenerate with `cds import …edmx --as cds` if you have cds-dk). Wired in `package.json` `cds.requires.ZUI_INVOICE_REVIEW_O4` (`kind: odata`, `model` always loaded). The live connection is a **CF service binding** under the **`s4` profile** (`npm run s4`) in `.cdsrc-private.json` — same pattern as the AI Core `default_aicore` binding: it references a CF **user-provided service** `ABMY_INVOICE_REVIEW` (holding the S/4 url + basic-auth creds), so **no secret is stored in any local file** (resolved from CF at runtime; requires `cf login`).
- **Profile-gated**: `srv/lib/s4-proxy.js` `register(srv)` is a **no-op unless the remote has credentials** (i.e. `--profile s4`), so the default/mock path is untouched. `invoice-review-service.js` only registers its local `verify`/`reject` handlers when delegation is off.
- **Name mapping is CQN-based, not string-based**: `MAPS` holds per-entity local↔S/4 element maps (`ID←→EmailUUID`, `documentNumber←→DocumentNumber`, `verificationStatus_code←→VerificationStatus`, nav `invoices←→_Invoice`, …). `remapSelect` rewrites the *parsed* query (`req.query`) — columns, `where`, `orderBy`, nested `expand` — onto the remote entity and pins `IsActiveEntity = true` (the remote is draft-enabled); `mapRowIn` maps result rows back and derives `isEditable` (no calc engine on delegated reads). The Email rollup reads via `this.run(...)` so it hits whichever backend is active.
- **Writes drive S/4's Email-rooted draft flow**: `verify`/`reject`, header edits, and line-item create/update/delete all do **Edit (on owning Email) → PATCH/POST/DELETE the draft node → Activate**. ⚠️ This write/draft path plus the exact remote `path`/destination need validation against the live system; the read path is the primary offline-verified surface.

## Architecture notes

- **LLM access goes through `@sap-ai-sdk/orchestration`'s `OrchestrationClient`** (`_createClient` in `srv/DocumentProcessingService.js`), not the `@sap-ai-sdk/langchain` package listed in `package.json`. The orchestration package is resolved transitively; if you add direct usage, add it to `package.json` explicitly.
- **Model and resource group are env-configurable**: `AICORE_INVOICE_MODEL` (default `anthropic--claude-4.6-sonnet`) and `AICORE_RESOURCE_GROUP` (default `abmy-project`). These target deployments configured in SAP AI Core, not the public Anthropic API — do not swap in raw `claude-*` model IDs or Anthropic SDK calls.
- **PDFs are sent as multimodal content items**: `_buildContentItem` wraps base64 PDF bytes as a `type: 'file'` message part (`data:application/pdf;base64,...`). User prompts are arrays mixing this file item with `type: 'text'` instructions.
- **Prompts demand strict JSON output.** Both handlers `JSON.parse` the model response directly and `req.error(500, ...)` on failure — there is no markdown-fence stripping or repair. The extraction prompt encodes detailed business rules (payee/GL/cost-center/internal-order regexes, line-item summation logic, OCR fallback precedence); treat that prompt text as the spec when changing extraction behavior.
- **Dev fallbacks are hardcoded** in `_getInvoicePages` / `_extractInvoice`: when an input is empty, the code reads `srv/Invoice.pdf` (pages) or `srv/Invoice_3.pdf` (extract) and injects a canned email string and a large canned OCR JSON blob. These sample PDFs live in `srv/`. (Note: comments in `test/request.http` reference `test/Invoice*.pdf`, but the actual fallback files are in `srv/`.)
- **Auth**: `xsuaa` is only required under the `[production]` profile (`package.json` `cds.requires`). Dev/hybrid runs are open. `xs-security.json` currently defines no scopes or roles.

## Layout

- `srv/` — the service (`.cds` model + `.js` implementation) and bundled sample invoice PDFs.
- `db/` — domain models would go here; currently only `undeploy.json` (HANA undeploy allowlist). No entities defined yet.
- `app/` — UI frontends (empty).
- `test/request.http` — manual HTTP requests against the running service.
