## Where PDFs come from

1. A browser you already have. The extension looks for Google Chrome, Microsoft Edge, Brave, Chromium or Vivaldi in the usual install folders. It starts it hidden, with a new temporary profile, prints the page and closes it. Your own browser profile, tabs and logins are never touched.
2. The built-in engine. No browser found? A JavaScript PDF writer inside the extension makes the PDF. The layout is simpler and Mermaid diagrams show as code.

Nothing is downloaded, in either case. With remote images off (the default) the extension makes no network request at all.

Set `markdownExport.browserPath` to use a browser in another folder, or `markdownExport.pdfEngine` to pick an engine.
