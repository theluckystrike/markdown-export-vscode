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
