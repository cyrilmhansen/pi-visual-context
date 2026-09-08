#let font-name = sys.inputs.at("font", default: "Romulus")
#let ncols = int(sys.inputs.at("cols", default: "3"))
#let scale = float(sys.inputs.at("scale", default: "1"))
#let font-size = float(sys.inputs.at("size", default: "10.753")) * scale * 1pt
#let leading = float(sys.inputs.at("leading", default: "2.151")) * scale * 1pt
#let side-margin = float(sys.inputs.at("margin", default: "12")) * 1pt
#let gutter-width = float(sys.inputs.at("gutter", default: "24")) * 1pt
#let source-file = sys.inputs.at("source")
#let banner-prefix = "__PI_VISUAL_CONTEXT_FILE__:"

#set page(
  width: 1056pt,
  height: 960pt,
  margin: (left: side-margin, right: side-margin, top: 2pt, bottom: 2pt),
  fill: white,
)
#set text(
  font: font-name,
  fallback: false,
  size: font-size,
  fill: black,
  kerning: false,
  ligatures: false,
  hyphenate: false,
)
#set par(leading: leading, justify: false)
#let render-line(content) = {
  if content.starts-with(banner-prefix) {
    let name = content.slice(banner-prefix.len())
    block(width: 100%, above: 2pt, below: 2pt)[
      #grid(
        columns: (1fr, auto, 1fr),
        gutter: 4pt,
        align: horizon,
        [#line(length: 100%, stroke: .45pt)],
        text(name, size: font-size, weight: "bold"),
        [#line(length: 100%, stroke: .45pt)],
      )
    ]
  } else {
    text(content)
    linebreak()
  }
}
#columns(ncols, gutter: gutter-width)[
  #for content in read(source-file).split("\n") {
    render-line(content)
  }
]
