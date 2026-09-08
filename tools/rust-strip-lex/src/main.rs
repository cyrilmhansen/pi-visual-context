use std::{env, fs, process::Command};
#[derive(Clone, Debug, PartialEq, Eq)]
enum K {
    Ws,
    Comment,
    Ident,
    Number,
    Literal,
    Punct,
}
#[derive(Clone, Debug)]
struct T {
    k: K,
    s: String,
}
mod rustc_lexer {
    use super::{K, T};
    fn is_id(b: u8) -> bool {
        b.is_ascii_alphanumeric() || b == b'_'
    }
    pub fn tokenize(s: &str) -> Vec<T> {
        let b = s.as_bytes();
        let mut i = 0;
        let mut v = Vec::new();
        while i < b.len() {
            let st = i;
            if b[i].is_ascii_whitespace() {
                i += 1;
                while i < b.len() && b[i].is_ascii_whitespace() {
                    i += 1;
                }
                v.push(T {
                    k: K::Ws,
                    s: s[st..i].into(),
                });
                continue;
            }
            if i + 1 < b.len() && &b[i..i + 2] == b"//" {
                i += 2;
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                v.push(T {
                    k: K::Comment,
                    s: s[st..i].into(),
                });
                continue;
            }
            if i + 1 < b.len() && &b[i..i + 2] == b"/*" {
                i += 2;
                let mut d = 1;
                while i < b.len() && d > 0 {
                    if i + 1 < b.len() && &b[i..i + 2] == b"/*" {
                        d += 1;
                        i += 2
                    } else if i + 1 < b.len() && &b[i..i + 2] == b"*/" {
                        d -= 1;
                        i += 2
                    } else {
                        i += 1
                    }
                }
                v.push(T {
                    k: K::Comment,
                    s: s[st..i].into(),
                });
                continue;
            }
            if b[i] == b'"' || b[i] == b'\'' {
                let q = b[i];
                i += 1;
                while i < b.len() {
                    if b[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if b[i] == q {
                        i += 1;
                        break;
                    }
                    i += 1
                }
                v.push(T {
                    k: K::Literal,
                    s: s[st..i].into(),
                });
                continue;
            }
            if b[i] == b'r' && (i + 1 < b.len() && (b[i + 1] == b'"' || b[i + 1] == b'#')) {
                i += 1;
                while i < b.len() && b[i] == b'#' {
                    i += 1
                }
                if i < b.len() && b[i] == b'"' {
                    i += 1;
                    while i < b.len() {
                        if b[i] == b'"' {
                            let mut j = i + 1;
                            while j < b.len() && b[j] == b'#' {
                                j += 1
                            }
                            if j > i + 1 {
                                i = j;
                                break;
                            }
                        }
                        i += 1
                    }
                }
                v.push(T {
                    k: K::Literal,
                    s: s[st..i].into(),
                });
                continue;
            }
            if b[i].is_ascii_alphabetic() || b[i] == b'_' {
                i += 1;
                while i < b.len() && is_id(b[i]) {
                    i += 1
                }
                v.push(T {
                    k: K::Ident,
                    s: s[st..i].into(),
                });
                continue;
            }
            if b[i].is_ascii_digit() {
                i += 1;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'.')
                {
                    i += 1
                }
                v.push(T {
                    k: K::Number,
                    s: s[st..i].into(),
                });
                continue;
            }
            let ops = [
                "<<=", ">>=", "..=", "=>", "==", "!=", "<=", ">=", "&&", "||", "->", "::", "+=",
                "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "..", "=>",
            ];
            let mut n = 1;
            for o in ops {
                if s[st..].starts_with(o) && o.len() > n {
                    n = o.len()
                }
            }
            i += n;
            v.push(T {
                k: K::Punct,
                s: s[st..i].into(),
            });
        }
        v
    }
}
fn enc(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '¶' => "¤¶".into(),
            '»' => "¤»".into(),
            '¤' => "¤¤".into(),
            '\n' => "¶".into(),
            '\t' => "»".into(),
            x => x.to_string(),
        })
        .collect()
}
fn sig(t: &T) -> (K, usize) {
    (t.k.clone(), t.s.as_bytes().len())
}
fn can_join(a: &T, b: &T) -> bool {
    let z = rustc_lexer::tokenize(&(a.s.clone() + &b.s));
    z.len() == 2
        && z[0].k != K::Ws
        && z[1].k != K::Ws
        && sig(&z[0]) == sig(a)
        && sig(&z[1]) == sig(b)
}
fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: rust-strip-lex <source.rs> <output.txt> <font.ttf>");
        std::process::exit(2);
    }
    let src = args[1].clone();
    let out = args[2].clone();
    let font = args[3].clone();
    let s = fs::read_to_string(&src).expect("read source");
    let ts = rustc_lexer::tokenize(&s);
    let orig_lf = s.bytes().filter(|&b| b == b'\n').count();
    let orig_tab = s.bytes().filter(|&b| b == b'\t').count();
    let mut o = String::new();
    let mut prev: Option<T> = None;
    let mut omissions = 0;
    for t in &ts {
        if t.k == K::Ws {
            if t.s.contains('\n') {
                for c in t.s.chars() {
                    if c == '\n' {
                        o.push_str("¶");
                    }
                }
                prev = None
            } else if prev.is_some() {
                continue;
            } else {
            }
        } else {
            if let Some(a) = &prev {
                if !can_join(a, t) {
                    o.push(' ')
                } else {
                    omissions += 1
                }
            }
            o.push_str(&enc(&t.s));
            prev = Some(t.clone())
        }
    }
    let visible = o.chars().count();
    let z = o.chars().filter(|&c| c == '¶').count();
    let tabs = o.chars().filter(|&c| c == '»').count();
    let spaces = o.chars().filter(|&c| c == ' ').count();
    let ratio = visible as f64 / s.chars().count() as f64;
    let zw = o.chars().flat_map(|c| [c, '\u{200b}']).collect::<String>();
    fs::write(&out, zw).expect("write output");
    // token-text validation: every non-whitespace token is emitted byte-for-byte after reserved decoding.
    let mut nonws = String::new();
    for t in &ts {
        if t.k != K::Ws {
            nonws.push_str(&t.s)
        }
    }
    let mut decoded = String::new();
    let mut it = o.chars();
    while let Some(c) = it.next() {
        if c == '¤' {
            if let Some(x) = it.next() {
                decoded.push(x)
            }
        } else if c == '¶' {
            decoded.push('\n')
        } else if c == '»' {
            decoded.push('\t')
        } else {
            decoded.push(c)
        }
    }
    let got: String = rustc_lexer::tokenize(&decoded)
        .into_iter()
        .filter(|t| t.k != K::Ws)
        .map(|t| t.s)
        .collect();
    assert_eq!(got, nonws, "token validation failed");
    assert_eq!(z, orig_lf, "LF validation failed");
    let charset = String::from_utf8(
        Command::new("fc-query")
            .args(["--format=%{charset}", &font])
            .output()
            .expect("fc-query")
            .stdout,
    )
    .unwrap();
    for c in o.chars() {
        if c == '\u{200b}' {
            continue;
        }
        let n = c as u32;
        let ok = charset.split_whitespace().any(|r| {
            let q: Vec<&str> = r.split('-').collect();
            let a = u32::from_str_radix(q[0], 16).unwrap();
            let b = q
                .get(1)
                .and_then(|x| u32::from_str_radix(x, 16).ok())
                .unwrap_or(a);
            n >= a && n <= b
        });
        assert!(ok, "unsupported Romulus character U+{:04X}", n)
    }
    println!("original bytes={} chars={} LF={} TAB={}\nencoded visible chars={} ¶={} »={} spaces={} compression ratio={:.4}\nomitted same-line whitespaces={} output={}",s.as_bytes().len(),s.chars().count(),orig_lf,orig_tab,visible,z,tabs,spaces,ratio,omissions,out);
}
