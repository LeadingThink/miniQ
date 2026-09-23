---
name: latex-workflow
description: Compile and diagnose LaTeX projects with reproducible logs and a visual PDF check.
version: 1
origin: bundled
requires:
  bins: [latexmk]
allowed_tools: [shell_run, file_read, file_write, view_pdf]
---

## Workflow
1. Check that `latexmk` and the project entry file are available before compiling.
2. Run the smallest reproducible build and inspect the complete error log when it fails.
3. Render the resulting PDF and check page breaks, references, fonts, and overfull boxes.
4. Keep auxiliary files in a build directory and report the exact command and output path.
