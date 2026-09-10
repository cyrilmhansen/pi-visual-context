use std::{env, fs};
use rustpython_parser::{ast, lexer, Mode, Parse, Tok};
use rustpython_parser::ast::Ranged;

fn enc_token(s: &str) -> String {
    s.chars().map(|c| match c {
        '¶' => "¤¶".into(), '»' => "¤»".into(), '¤' => "¤¤".into(),
        '\t' => "¤»".into(), '\n' => "¶".into(), x => x.to_string(),
    }).collect()
}

fn lex_tokens(s: &str) -> Result<Vec<Tok>, String> {
    lexer::lex(s, Mode::Module).map(|item| item.map(|(tok, _)| tok).map_err(|e| format!("{e:?}"))).collect()
}

fn structural_lfs(s: &str) -> usize {
    let mut previous = None;
    s.chars().filter(|&c| { let structural = c == '¶' && previous != Some('¤'); previous = Some(c); structural }).count()
}

fn can_join(a: &Tok, a_text: &str, b: &Tok, b_text: &str) -> bool {
    if matches!(a, Tok::Comment(_) | Tok::Newline | Tok::NonLogicalNewline | Tok::Indent | Tok::Dedent | Tok::EndOfFile)
        || matches!(b, Tok::Comment(_) | Tok::Newline | Tok::NonLogicalNewline | Tok::Indent | Tok::Dedent | Tok::EndOfFile) { return false; }
    let Ok(tokens) = lex_tokens(&format!("{a_text}{b_text}")) else { return false; };
    let tokens: Vec<Tok> = tokens.into_iter().filter(|t| *t != Tok::EndOfFile).collect();
    tokens.len() == 2 && tokens[0] == *a && tokens[1] == *b
}

#[derive(Clone)]
struct SymbolRecord { name: String, qualified_name: String, kind: &'static str, line: usize }

fn source_line(source: &str, offset: usize) -> usize {
    let mut line = 1;
    let bytes = source.as_bytes();
    let mut index = 0;
    while index < offset && index < bytes.len() {
        if bytes[index] == b'\n' { line += 1; }
        else if bytes[index] == b'\r' && (index + 1 >= bytes.len() || bytes[index + 1] != b'\n') { line += 1; }
        index += 1;
    }
    line
}

fn json_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r"))
}

fn collect_symbols(body: &[ast::Stmt], source: &str, scope: &[(String, bool)], output: &mut Vec<SymbolRecord>) {
    for statement in body {
        match statement {
            ast::Stmt::ClassDef(node) => {
                let name = node.name.to_string();
                let qualified_name = scope.iter().map(|item| item.0.as_str()).chain(std::iter::once(name.as_str())).collect::<Vec<_>>().join(".");
                output.push(SymbolRecord { name: name.clone(), qualified_name, kind: "type", line: source_line(source, node.range().start().to_usize()) });
                let mut next = scope.to_vec();
                next.push((name, true));
                collect_symbols(&node.body, source, &next, output);
            }
            ast::Stmt::FunctionDef(node) => {
                let name = node.name.to_string();
                let qualified_name = scope.iter().map(|item| item.0.as_str()).chain(std::iter::once(name.as_str())).collect::<Vec<_>>().join(".");
                let kind = if scope.last().is_some_and(|item| item.1) { "method" } else { "function" };
                output.push(SymbolRecord { name: name.clone(), qualified_name, kind, line: source_line(source, node.range().start().to_usize()) });
                let mut next = scope.to_vec();
                next.push((name, false));
                collect_symbols(&node.body, source, &next, output);
            }
            ast::Stmt::AsyncFunctionDef(node) => {
                let name = node.name.to_string();
                let qualified_name = scope.iter().map(|item| item.0.as_str()).chain(std::iter::once(name.as_str())).collect::<Vec<_>>().join(".");
                let kind = if scope.last().is_some_and(|item| item.1) { "method" } else { "function" };
                output.push(SymbolRecord { name: name.clone(), qualified_name, kind, line: source_line(source, node.range().start().to_usize()) });
                let mut next = scope.to_vec();
                next.push((name, false));
                collect_symbols(&node.body, source, &next, output);
            }
            _ => {}
        }
    }
}

fn emit_symbols(source: &str) {
    let Ok(ast) = ast::Suite::parse(source, "<symbols>") else { println!("[]"); return; };
    let mut records = Vec::new();
    collect_symbols(&ast, source, &[], &mut records);
    let json = records.into_iter().map(|record| format!("{{\"name\":{},\"qualifiedName\":{},\"kind\":{},\"line\":{}}}", json_string(&record.name), json_string(&record.qualified_name), json_string(record.kind), record.line)).collect::<Vec<_>>().join(",");
    println!("[{json}]");
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() == 3 && args[1] == "--symbols-json" {
        let source = fs::read_to_string(&args[2]).unwrap_or_default();
        emit_symbols(&source);
        return;
    }
    if args.len() != 4 { eprintln!("usage: python-strip-lex <source.py> <output.txt> <font.ttf>"); std::process::exit(2); }
    let source = fs::read_to_string(&args[1]).expect("read source");
    lex_tokens(&source).unwrap_or_else(|e| { eprintln!("Python lexical error: {e}"); std::process::exit(1); });
    let mut output = String::new();
    let mut cursor = 0usize;
    let mut previous: Option<(Tok, String)> = None;
    let mut depth = 0usize;
    let mut logical_line_start = true;
    let mut suppress_indent = false;
    let mut after_newline = false;
    for item in lexer::lex(&source, Mode::Module) {
        let (tok, range) = item.unwrap_or_else(|e| { eprintln!("Python lexical error: {e:?}"); std::process::exit(1); });
        let start = range.start().to_usize();
        let end = range.end().to_usize();
        let gap = &source[cursor..start];
        if !gap.is_empty() {
            if gap.contains('\n') && !gap.contains('\\') {
                for c in gap.chars() { if c == '\n' { output.push('¶'); logical_line_start = true; suppress_indent = false; after_newline = true; } }
            } else if after_newline || matches!(tok, Tok::Indent | Tok::Dedent) {
                // Physical indentation belongs to the logical depth marker.
            } else if !logical_line_start {
                if let Some((prev_tok, prev_text)) = &previous {
                    let current_text = &source[start..end];
                    if !can_join(prev_tok, prev_text, &tok, current_text) { output.push(' '); }
                }
            }
        }
        match &tok {
            Tok::Indent => { depth += 1; logical_line_start = true; suppress_indent = false; }
            Tok::Dedent => { depth = depth.saturating_sub(1); logical_line_start = true; suppress_indent = false; }
            Tok::Newline => {
                let explicit_continuation = source[..start].ends_with('\\') || source[start..end].contains('\\');
                if explicit_continuation { output.push('\\'); }
                if !gap.contains('\n') { output.push('¶'); }
                logical_line_start = true;
                suppress_indent = explicit_continuation;
                after_newline = true;
            }
            Tok::NonLogicalNewline => {
                if !gap.contains('\n') { output.push('¶'); }
                after_newline = true;
            }
            Tok::EndOfFile => {}
            _ => {
                if logical_line_start {
                    let comment_indent = matches!(tok, Tok::Comment(_)) && source[..start].rsplit('\n').next().is_some_and(|line| line.chars().any(|c| c == ' ' || c == '\t'));
                    if !suppress_indent {
                        if depth > 0 { output.push_str(&format!("{depth}»")); }
                        else if comment_indent { output.push_str("1»"); }
                    }
                    logical_line_start = false;
                    suppress_indent = false;
                }
                let text = source[start..end].to_string();
                output.push_str(&enc_token(&text));
                previous = Some((tok, text));
                after_newline = false;
            }
        }
        cursor = end;
    }
    if cursor < source.len() {
        for c in source[cursor..].chars() { if c == '\n' { output.push('¶'); } }
    }
    let expected_linefeeds = source.matches('\n').count();
    let mut linefeeds = structural_lfs(&output) + output.chars().filter(|&c| c == '\n').count();
    while linefeeds < expected_linefeeds { output.push('¶'); linefeeds += 1; }
    let visible = output.chars().count();
    fs::write(&args[2], output.chars().flat_map(|c| [c, '\u{200b}']).collect::<String>()).expect("write output");

    assert_eq!(linefeeds, expected_linefeeds, "LF validation failed");

    println!("original bytes={} chars={} LF={}\nencoded visible chars={} compression ratio={:.4}", source.len(), source.chars().count(), linefeeds, visible, visible as f64 / source.chars().count() as f64);
}
