---
name: document-workflow
description: Create, edit, inspect, and render Word documents with a visual verification pass.
version: 1
origin: bundled
allowed_tools: [doc_read, doc_write, file_read, file_write, shell_run]
---

## Workflow
1. Inspect the source document with `doc_read` before making changes.
2. Apply edits with `doc_write` and keep the user's existing styles unless asked otherwise.
3. Render the result to page images, inspect every page, and report any layout issue before delivery.
4. Keep the original file untouched and write the result to a clearly named output path.
