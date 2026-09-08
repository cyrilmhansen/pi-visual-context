use std::{env, fs, process::Command};
use rustpython_parser::{lexer, Mode, Tok};

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

fn main() {
    let args: Vec<String> = env::args().collect();
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

    let charset = String::from_utf8(Command::new("fc-query").args(["--format=%{charset}", &args[3]]).output().expect("fc-query").stdout).unwrap();
    for c in output.chars() {
        if c == '\n' || c == '\t' { continue; }
        let n = c as u32;
        let supported = charset.split_whitespace().any(|range| { let parts: Vec<&str> = range.split('-').collect(); let lo = u32::from_str_radix(parts[0], 16).unwrap(); let hi = parts.get(1).and_then(|x| u32::from_str_radix(x, 16).ok()).unwrap_or(lo); n >= lo && n <= hi });
        assert!(supported, "unsupported font character U+{:04X}", n);
    }
    println!("original bytes={} chars={} LF={}\nencoded visible chars={} compression ratio={:.4}", source.len(), source.chars().count(), linefeeds, visible, visible as f64 / source.chars().count() as f64);
}
