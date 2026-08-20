# Test fixtures

`footnotes.epub` — a minimal EPUB 3 with `epub:type="noteref"` links and
`epub:type="footnote"` asides. None of the Project Gutenberg books carry
that markup, so the footnote popover cannot be exercised without it.

Copy it into `library/` and rescan to test:

    cp fixtures/footnotes.epub library/ && curl -X POST localhost:8787/api/library/scan
