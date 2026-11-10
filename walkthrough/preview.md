## Export Preview

The preview shows the Markdown on a sheet with the page size and margins of your PDF. It updates as you type (large files update when you save).

- PDF, Word and HTML buttons export the file you are looking at.
- White paper / Theme colours switches between print colours and your editor theme.
- Settings opens page size, margins, header, footer and the table of contents.

## Paper, margins, header and footer

Settings apply to every file. Front matter at the top of a file changes them for that file only:

```yaml
---
title: Quarterly report
pageSize: Letter        # A4, Letter, Legal, A3, A5, B5, Tabloid
landscape: false
margin: 20mm 15mm       # top/bottom, left/right
header: "{title}"
footer: "Page {page} of {pages}"
toc: true
---
```

Put `<!-- pagebreak -->` on its own line to start a new page.
