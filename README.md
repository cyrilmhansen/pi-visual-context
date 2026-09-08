# pi-visual-context

Experimental Pi extension for adding dense visual source-code context to multimodal LLM conversations.

The core idea is simple:

> Instead of sending large source files only as text tokens, render a compact symbolic view of the source as an image and attach that image to the conversation.

This repository explores that idea first for Rust source code.

## Motivation

Modern multimodal LLMs can read dense source-code images surprisingly well.

In early experiments with GPT-6 Astra, a compact Romulus-based rendering preserved useful semantic readability while fitting substantially more source code into a fixed-size image than more conservative typography.

The current prototype uses:

- Rust lexical compaction
- explicit line-break markers
- dense multi-column layout
- Romulus bitmap-inspired typography
- supersampled antialiased rasterization
- Pi multimodal image attachments

The goal is not OCR-perfect reconstruction.

The goal is to provide enough visual evidence for the model to understand large amounts of source code efficiently.

## Current default profile

The current provisional profile is:

```text
language: Rust
font: Romulus
columns: 3
scale: 1.00
side margins: 12
column gutter: 24
page size: 1056 × 960
rendering: Typst -> 1152 DPI raster -> box downsample to 1056 × 960
```

Rust source is transformed into a compact visual representation before rendering.

For example:

```text
newline -> ¶
indentation -> compacted / removed depending on representation
unnecessary token whitespace -> removed when lexically safe
```

The original source file is never modified.

## Experimental results

These results are exploratory and based on small samples.

For one Rust `serde_json/src/de.rs` test page:

| Layout | Visible chars/page | GPT-6 Astra exact answers |
| --- | ---: | ---: |
| Romulus, m64/g32 | 18,428 | 7/8 |
| Romulus, m12/g24 | 21,088 | 7/8 |
| Romulus, m8/g16 | 21,546 | 6/8 |
| Romulus, scale 0.90 | 22,738 | 6/8 |

A more conservative Pixel Operator rendering achieved 8/8 on the same small semantic test, but with lower density:

```text
14,774 visible chars/page
```

These numbers are not intended as a formal benchmark yet.

They mainly suggest that there is a useful trade-off between visual density and semantic readability.

## Why visual context?

A fixed-size image can encode much more than plain characters:

- lexical content
- spatial grouping
- column structure
- syntax categories
- provenance
- annotations
- relationships
- future use of color and graphical symbols

The long-term idea is to treat visual context as a symbolic representation layer for multimodal LLMs, rather than as a screenshot-oriented interface.

## Planned Pi integration

The first Pi integration will be intentionally small.

Conceptually:

```text
/vfile src/parser.rs
```

will:

```text
Rust source
    ↓
lexical compaction
    ↓
visual encoding
    ↓
Typst rendering
    ↓
PNG page(s)
    ↓
Pi ImageContent attachment(s)
```

Pi will then persist the images as part of the conversation session.

## Project status

Very early experimental prototype.

Current priorities:

- minimal `/vfile` Pi extension
- reusable rendering pipeline
- Rust source codec
- session persistence testing
- source-to-image indexing
- later: multiple density profiles
- later: other languages and conversation archives

## Requirements

The current prototype pipeline expects:

- Node.js
- Pi
- Typst
- Poppler (`pdftocairo`, `pdftotext`)
- ImageMagick
- Rust tooling for lexical processing

Exact installation instructions will be added once the first end-to-end extension is working.

## Design principles

- keep the source canonical and unchanged
- treat the visual representation as derived context
- optimize for model readability, not human typography
- keep experiments reproducible
- reuse infrastructure instead of creating one-off benchmark scripts
- separate rendering parameters from benchmark logic
- prefer small, controlled experiments over large sweeps

## License

TBD.

Font redistribution will be handled separately and only after verifying the relevant font licenses.
