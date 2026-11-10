# Changelog

## 0.1.1 (2026-11-10)

- New name: Markdown to PDF & Markdown to Word (DOCX, HTML Export, No Chromium Download). Same extension id and settings.
- A Zovo Pro try is now used only after a file was saved with the tool, and one export run uses at most one try per tool, even for a whole folder. Cancel or a failed export keeps the try.
- The Zovo Pro panel shows the price once (USD 19), the other Pro tools and four buttons: Get Zovo Pro, Pay with PayPal, I already paid, Cancel. It appears at most once per export run.
- New command Zovo Pro: Pay for Zovo Pro with PayPal.
- Folder export and Merge a Folder into One PDF list the workspace folders and the folders with Markdown files, so you can pick one without browsing.
- The walkthrough opens a sample file with a table, code, a formula, a Mermaid diagram and an image.
- Word templates are size-checked (50 MB file, 16 MB of styles). A template that cannot be read is skipped with a note and uses no try.
- Notes that repeat for PDF, Word and HTML in one run show once.
- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.
- The walkthrough ends with a step that links free Zovo extensions for the files that often come with this one. A link opens the extension page; nothing installs on its own.
- The footer link "Zovo Pro, USD 19" and the Marketplace Sponsor button open the Zovo Pro tier (USD 19 once, for every Zovo extension) instead of the general GitHub Sponsors page.

## 0.1.0 (2026-11-09)

- First release. Export Markdown to PDF, Word (DOCX) and HTML.
- PDF with the Chrome, Edge, Brave or Chromium already on the computer. Nothing is downloaded. A built-in engine makes the PDF when no browser is found.
- Word export with real Heading 1 to 6 styles, numbered and bulleted lists, tables, code colours, images, footnotes, links, page breaks, header, footer and page numbers.
- KaTeX math, Mermaid diagrams, task lists, footnotes and a table of contents in every format.
- Export the open file, a selection, several files or every Markdown file in a folder.
- Export Preview with the page size and margins of the PDF.
- No network: remote images stay off unless you turn them on. Scripts in the Markdown never run.
- Zovo Pro extras (3 free tries each): merge a folder into one PDF, a Word template, a cover page.
