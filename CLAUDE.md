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

An end-to-end review/verification UI built as **Fiori Elements** (List Report + Object Page). Currently runs on **local mock data** but is modeled as the contract a future **single combined S/4HANA OData service** will implement (attachments map to an S/4 custom table XSTRING column). See `.claude/plans/i-want-to-create-fuzzy-turing.md` for the full design and the mock→S/4 migration path.

- **Model** (`db/schema.cds`, namespace `abeam.invoicereview`): one `Invoices` entity carrying email metadata + invoice header + a `verificationStatus` (code list `VerificationStatuses`: P/V/R with a `criticality` column for FE coloring), plus compositions `lineItems` and `attachments` (media entity, `LargeBinary content @Core.MediaType`).
  - Field-name mapping vs. `DocumentProcessingService` types: `documentNumber←invoiceNumber`, `documentDate←invoiceDate`, `vendor*←payee*`.
  - `isEditable : Boolean = verificationStatus.code = 'P'` is a **calculated element** and the single source of truth for editability.
- **Service** (`srv/invoice-review-service.cds` + `.js`): `@odata.draft.enabled` projection with bound actions `verify()` / `rejectInvoice()`. Note `reject` was renamed to `rejectInvoice` because a plain `reject` action **collides with a base-class method** on `cds.ApplicationService` (label stays "Reject"). Handlers set the status; a `cds.once('served')` hook hydrates mock attachment binaries from the sample PDFs in `srv/`.
- **Annotations + the verify lock** (`srv/invoice-review-annotations.cds`): the whole Object Page becomes read-only after Verify/Reject via `Capabilities.UpdateRestrictions: { Updatable: isEditable }`. **Gotcha:** the flattened form `UpdateRestrictions.Updatable : isEditable` folds to a static `false` — you must use the record form `{ Updatable: isEditable }` to emit a path binding.
- **Custom FE extensions** (`app/invoicereview/webapp/ext/`): the email body is an HTML custom section (`sap.ui.core.HTML`, sanitized with `sap/base/security/sanitizeHTML`); the Attachments button opens a dialog listing attachments. Because the entity is draft-enabled, media/entity keys **must include `IsActiveEntity`** — e.g. `Attachments(ID=<guid>,IsActiveEntity=true)/content`.
- **App scaffolding**: hand-authored (no `@sap/generator-fiori` installed) and served statically by `cds watch`; UI5 bootstraps from the CDN in `index.html`.

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
