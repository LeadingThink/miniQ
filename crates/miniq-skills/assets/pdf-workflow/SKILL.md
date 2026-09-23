---
name: pdf-workflow
description: Read, create, and verify PDF documents, including page rendering and form-safe handling.
version: 1
origin: bundled
allowed_tools: [pdf_read, pdf_write, view_pdf, file_read, file_write]
---

## Workflow
1. Read the PDF metadata and extract text before editing or summarizing.
2. Render every affected page with `view_pdf` and inspect the visual result.
3. Preserve page size, fonts, links, and form fields unless the request changes them.
4. Return the output path and a short verification report.
