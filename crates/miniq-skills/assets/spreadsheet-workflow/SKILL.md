---
name: spreadsheet-workflow
description: Modify spreadsheets with formulas, formatting, charts, and recalculation checks.
version: 1
origin: bundled
allowed_tools: [file_read, file_write, shell_run]
---

## Workflow
1. Inspect sheets, formulas, named ranges, and existing number formats.
2. Make the smallest edit that satisfies the request; never replace formulas with displayed values.
3. Recalculate, inspect affected cells and charts, and verify that no error values were introduced.
4. Save a copy and report the changed sheets and validation result.
