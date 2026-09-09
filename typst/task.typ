#let font-name = sys.inputs.at("font", default: "Romulus")
#let ncols = int(sys.inputs.at("cols", default: "3"))
#let font-size = float(sys.inputs.at("size", default: "16")) * 1pt
#let leading = float(sys.inputs.at("leading", default: "6")) * 1pt
#let side-margin = float(sys.inputs.at("margin", default: "64")) * 1pt
#let gutter-width = float(sys.inputs.at("gutter", default: "32")) * 1pt
#let source-file = sys.inputs.at("source")

#set page(
  width: 1056pt,
  height: 960pt,
  margin: (left: side-margin, right: side-margin, top: 2pt, bottom: 2pt),
  fill: white,
)
#set text(
  font: font-name,
  fallback: true,
  size: font-size,
  fill: black,
  kerning: false,
  ligatures: false,
  hyphenate: false,
)
#set par(leading: leading, justify: false)
#columns(ncols, gutter: gutter-width)[
  #for content in read(source-file).split("\n") {
    text(content)
    linebreak()
  }
]
