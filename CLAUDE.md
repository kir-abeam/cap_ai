# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`ai_cap` is a SAP Cloud Application Programming (CAP) Node.js service that extracts structured invoice data from PDF documents using LLMs hosted on SAP AI Core. It exposes a single unauthenticated-in-dev service, `DocumentProcessingService`, at path `/document-processing-service` with two AI-backed actions:

- `getInvoicePages(fileContent)` — identifies page ranges in a (possibly multi-invoice) PDF, returns `many PageRange`.
- `extractInvoice(invoiceContent, emailContent, ocrResults)` — extracts a structured `InvoiceHeader` (with `lineItems`) from a PDF plus email text plus existing OCR JSON.

All inputs are `LargeString` (base64 PDF / plain text / JSON string). Return types are CDS `type`s defined in `srv/DocumentProcessingService.cds`.

## Commands

- `npm start` — runs `cds-serve` (production-style serve).
- `npm run hybrid` — runs `cds watch --profile hybrid`; this is the primary dev loop. The `hybrid` profile binds to a real SAP AI Core instance via `.cdsrc-private.json` (gitignored), so it needs Cloud Foundry credentials for the `default_aicore` service in the `ABeam Consulting Ltd.` org / `dev` space.
- Manual testing: use `test/request.http` (REST Client). Both actions accept an empty body `{}` and fall back to bundled sample data (see below), so you can exercise the AI path without supplying a PDF.

There is no test runner, linter, or build step configured. `@cap-js/sqlite` is a dev dependency for CAP's default in-memory persistence, but this project defines no entities/tables — the service is action-only.

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
