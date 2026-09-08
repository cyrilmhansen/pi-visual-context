#let source-file = sys.inputs.at("source")
#set page(
  width: 1056pt,
  height: 960pt,
  margin: (left: 12pt, right: 12pt, top: 8pt, bottom: 2pt),
  fill: white,
)
#set text(
  font: "Romulus",
  fallback: false,
  size: 10.753pt,
  fill: black,
  kerning: false,
  ligatures: false,
  hyphenate: false,
)
#set par(leading: 2.151pt, justify: false)
#columns(3, gutter: 24pt)[#text(read(source-file))]
