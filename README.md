# pi-visual-context

Experimental Pi extension for adding dense visual source-code context to multimodal LLM conversations.

The core idea is simple:

> Instead of sending large source files only as text tokens, render a compact symbolic view of the source as an image and attach that image to the conversation.

This repository currently supports Rust, C, and Python source code.

## Motivation

Modern multimodal LLMs can read dense source-code images surprisingly well.

In early experiments with GPT-6 Astra, a compact Romulus-based rendering preserved useful semantic readability while fitting substantially more source code into a fixed-size image than more conservative typography.

The current prototype uses:

- Rust, C, and dense Python lexical compaction
- explicit line-break markers and logical-depth markers
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

## Pi integration

The local `/visual-context` command shows the compact usage summary and does not render or call a model. The work interface remains `@v`:

```text
/visual-context
```

The extension accepts:

```text
@v src/parser.rs -- Explain the architecture.
@v --profile conservative src/parser.rs -- Explain the architecture.
@v src/foo.rs src/bar.rs -- Explain how these modules interact.
@v src/**/*.py helper.rs -- Explain how these components interact.
@v --render --profile conservative src/**/*.py
@v --render --open src/**/*.py
@v --visual-prompt src/**/*.py -- Explain the architecture in detail.
@v --visual-prompt -- Explain the architecture without source files.
@v --visual-prompt --render src/**/*.py -- Explain the architecture in detail.
@v external/opl3/opl3.h external/opl3/opl3.c -- Explain how this API works.
```

Conceptually:

```text
Rust or C source
    ↓
language-specific lexical compaction
    ↓
visual encoding
    ↓
Typst rendering
    ↓
PNG page(s)
    ↓
Pi ImageContent attachment(s)
```

Pi will then persist the images as part of the conversation session. Multiple files are compacted into one continuous Typst document with compact centered graphical transition bands. `--render` runs the same pipeline but stops after writing the PNGs and manifest, without calling a model; `--open` additionally opens the first PNG when a native viewer is available.

Build the local Rust and C helpers once before use:

```bash
npm run build:rust
```

## Project status

First release candidate; intentionally narrow.

Current scope:

- `@v` Pi input transformation
- Rust, C, and Python source codecs, with specialized codecs taking priority
- generic strict UTF-8 text fallback for other files
- `.rs`, `.c`, `.h`, and `.py` inputs, plus UTF-8 text files without an extension or with unknown extensions, including deterministic `*` and `**` globs
- glob results sorted lexically, deduplicated, and restricted to regular files
- ordered multifile PNG attachments and debug manifests
- `@v --render` preview mode, with optional `--open` and no model call
- continuous multifile rendering with global tablet headers
- file-count confirmation via `PI_VISUAL_CONTEXT_CONFIRM_FILES` (default 20) before compacting, and tablet confirmation via `PI_VISUAL_CONTEXT_MAX_TABLETS` (default 10) after PDF layout and before rasterization
- normal and conservative rendering profiles
- deterministic final-PNG cache in `.pi/visual-context/cache/`, keyed by source bytes, order, display names, profile, template, font, and renderer parameters; Git provenance is manifest-only and does not affect the key; set `PI_VISUAL_CONTEXT_CACHE=0` to disable it
- bounded parallel rasterization and per-page post-processing, defaulting to at most 4 workers; override with `PI_VISUAL_CONTEXT_RASTER_WORKERS`
- deterministic Romulus cmap classification: compatible files render in the normal group, while files containing missing glyphs render in the conservative fallback group
- binary files and invalid UTF-8 are rejected by the generic text fallback; legacy encodings are not detected
- best-effort `fontsUsed` metadata extracted from each rendered PDF, including TASK and source render groups

Source patterns preserve argument order; each glob is sorted lexically, duplicates are removed at first occurrence, and a glob with no regular-file matches is an error. Python uses `¶` for logical line breaks, including LF characters inside multiline strings, and `N»` for logical indentation depth (`»` is the bundled-font equivalent of `⇥`); continuation indentation is omitted. Literal `\\n` sequences remain unchanged. The C and Python codecs are lexical only: they do not preprocess, expand macros, reformat, or rewrite source. Comments, directives, macros, strings, characters, indentation, and significant newlines are preserved. Other languages, indexing, and archive features remain out of scope.

## Requirements

Rasterization and final PNG post-processing run page-by-page in a bounded worker pool (default maximum: 4), while preserving deterministic page order and bytes. Set `PI_VISUAL_CONTEXT_RASTER_WORKERS=1` for the sequential reference pipeline.

When the requested profile is `normal`, each compacted file is classified using the bundled Romulus cmap, including its visual filename. Romulus-compatible files are rendered first with the normal profile; files requiring fallback glyphs are rendered afterward with the existing conservative profile. An explicit `--profile conservative` keeps the entire request conservative. Romulus is the only bundled font. Typst fallback is best-effort and uses fonts installed on the host, so Unicode appearance can differ between machines. With system fonts disabled, the installed Typst version still exits successfully and produces a PDF for an unavailable emoji glyph, without a reliable missing-glyph diagnostic; the project therefore does not scan pixels or system cmaps for tofu detection. `fontsUsed` records the normalized font names reported by `pdffonts` for each actual PDF; an empty list means that diagnostic was unavailable.

Debug manifests also include best-effort local Git provenance for each distinct repository. It is informational, supports files outside Git and multiple repositories, and is refreshed on cache hits without invalidating the rendered-image cache.

`--visual-prompt` can render only TASK tablets with no source files, or TASK tablets followed by SOURCE tablets. The short historical text mode remains preferable for short questions.

SOURCE tablets are addressable as `VC-001`, `VC-002`, and so on. The identifier depends on final SOURCE page order and is visible in the SOURCE header. Manifests record each tablet’s profile, dimensions, original source paths, and 1-based inclusive original line spans. A wrapped source line may legitimately occur in two adjacent tablets. TASK tablets do not receive VC identifiers.

When SOURCE images are attached, the model-facing text also contains a compact tablet index, for example:

```text
VC-001 foo.py:1-184
VC-002 foo.py:184-320 | bar.c:1-37
```

This is an address map, not a second copy of the source. It uses the canonical `source.tablets` provenance, preserves visual names and overlapping line ranges, and marks empty files as `file.py:empty`. In unusual visual names, `|`, `:`, backslashes, and line breaks are escaped with a backslash.

The generic text fallback preserves text structure without parsing Markdown, JSON, YAML, or other grammars. It normalizes CRLF/CR to LF and expands tabs to four spaces deterministically. Specialized `.rs`, `.c`/`.h`, and `.py` codecs always take priority. Unicode text follows the same normal/conservative Romulus classification as source files.

The final rendered PNGs are cached locally after a successful render. Source entries remain in `.pi/visual-context/cache/`; opt-in TASK entries use the separate `.pi/visual-context/cache/task/` namespace. Cache entries are content-addressed and invalidated automatically when any source, profile, visual name, template, font, codec convention, or renderer parameter changes. Opt-in `--visual-prompt` renders the natural-language question as separate TASK tablets before the SOURCE tablets; its cache is keyed only by the exact prompt and task renderer identity. For short questions, the historical text mode is usually more efficient. The cache key does not fingerprint the host's system fallback-font inventory: if installed fonts change, use `PI_VISUAL_CONTEXT_CACHE=0` once or purge `.pi/visual-context/cache/` and `.pi/visual-context/cache/task/`. Debug output remains per invocation; set `PI_VISUAL_CONTEXT_CACHE=0` (also accepts `false`, `no`, or `off`) to disable both caches.

The current prototype pipeline expects:

- Node.js
- Pi
- Typst
- Poppler (`pdftocairo`, `pdftotext`, and `pdffonts` for render diagnostics)
- ImageMagick
- Rust tooling for the Rust and C lexical helpers

Romulus is bundled at `assets/fonts/romulus/Romulus.ttf`.

Attribution: Romulus, copyright/author Hewett Tsoi, source: https://www.dafont.com/romulus.font. DaFont lists it as 100% Free; the author's note says, "Credit is appreciated." The same attribution is recorded in `THIRD_PARTY_NOTICES.md`.

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
