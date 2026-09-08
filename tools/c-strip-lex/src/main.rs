use std::{env, fs};

#[derive(Clone, Debug, PartialEq, Eq)]
enum K { Ws, Comment, Ident, Number, Literal, Punct }
#[derive(Clone, Debug)] struct T { k: K, s: String }

fn is_id(b: u8) -> bool { b.is_ascii_alphanumeric() || b == b'_' }
fn tokenize(s: &str) -> Vec<T> {
    let b = s.as_bytes(); let mut i = 0; let mut out = Vec::new();
    while i < b.len() {
        let st = i;
        if b[i].is_ascii_whitespace() { i += 1; while i < b.len() && b[i].is_ascii_whitespace() { i += 1; } out.push(T{k:K::Ws,s:s[st..i].into()}); continue; }
        if i+1 < b.len() && &b[i..i+2] == b"//" { i += 2; while i < b.len() && b[i] != b'\n' { i += 1; } out.push(T{k:K::Comment,s:s[st..i].into()}); continue; }
        if i+1 < b.len() && &b[i..i+2] == b"/*" { i += 2; while i+1 < b.len() && &b[i..i+2] != b"*/" { i += 1; } if i+1 < b.len() { i += 2; } out.push(T{k:K::Comment,s:s[st..i].into()}); continue; }
        if b[i] == b'"' || b[i] == b'\'' || (b[i] == b'u' && i+1 < b.len() && (b[i+1] == b'8' || b[i+1] == b'"' || b[i+1] == b'\'')) || (b[i] == b'L' && i+1 < b.len() && (b[i+1] == b'"' || b[i+1] == b'\'')) {
            if b[i] == b'u' && i+1 < b.len() && b[i+1] == b'8' { i += 2; } else if b[i] == b'u' || b[i] == b'L' { i += 1; }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') { let q=b[i]; i+=1; while i<b.len() { if b[i]==b'\\' { i+=2; continue; } if b[i]==q {i+=1;break} i+=1; } }
            out.push(T{k:K::Literal,s:s[st..i].into()}); continue;
        }
        if b[i].is_ascii_alphabetic() || b[i] == b'_' { i+=1; while i<b.len() && is_id(b[i]) {i+=1;} out.push(T{k:K::Ident,s:s[st..i].into()}); continue; }
        if b[i].is_ascii_digit() { i+=1; while i<b.len() && (b[i].is_ascii_alphanumeric() || b[i]==b'_' || b[i]==b'.') {i+=1;} out.push(T{k:K::Number,s:s[st..i].into()}); continue; }
        const OPS: [&str; 35] = ["<<=",">>=","...","->","++","--","+=","-=","*=","/=","%=","&=","|=","^=","<<",">>","<=",">=","==","!=","&&","||","##","::","..","=>","?","#","<",">","+","-","*","/","%"];
        let mut n=1; for op in OPS { if s[st..].starts_with(op) && op.len()>n {n=op.len();} } i+=n; out.push(T{k:K::Punct,s:s[st..i].into()});
    } out
}
fn enc(s: &str) -> String { s.chars().map(|c| match c {'¶'=>"¤¶".into(),'»'=>"¤»".into(),'¤'=>"¤¤".into(),'\n'=>"¶".into(),'\t'=>"»".into(),x=>x.to_string()}).collect() }
fn sig(t:&T)->(K,usize){(t.k.clone(),t.s.len())}
fn can_join(a:&T,b:&T)->bool { let z=tokenize(&(a.s.clone()+&b.s)); z.len()==2 && z[0].k!=K::Ws && z[1].k!=K::Ws && sig(&z[0])==sig(a) && sig(&z[1])==sig(b) }
fn main() {
    let a:Vec<String>=env::args().collect(); if a.len()!=4 {eprintln!("usage: c-strip-lex <source.c> <output.txt> <font.ttf>");std::process::exit(2)}
    let source=fs::read_to_string(&a[1]).expect("read source"); let ts=tokenize(&source); let mut out=String::new(); let mut prev:Option<T>=None;
    for t in &ts { if t.k==K::Ws { if t.s.contains('\n') { for c in t.s.chars(){if c=='\n'{out.push('¶')}} prev=None; } else if prev.is_none() {} } else { if let Some(p)=&prev {if !can_join(p,t){out.push(' ');}} out.push_str(&enc(&t.s)); prev=Some(t.clone()); } }
    let visible=out.chars().count(); let lf=out.chars().filter(|&c|c=='¶').count(); let zw=out.chars().flat_map(|c|[c,'\u{200b}']).collect::<String>(); fs::write(&a[2],zw).expect("write output");
    let mut decoded=String::new(); let mut it=out.chars(); while let Some(c)=it.next(){if c=='¤'{if let Some(x)=it.next(){decoded.push(x)}}else if c=='¶'{decoded.push('\n')}else if c=='»'{decoded.push('\t')}else{decoded.push(c)}}
    let original: String=ts.iter().filter(|t|t.k!=K::Ws).map(|t|t.s.as_str()).collect(); let got:String=tokenize(&decoded).iter().filter(|t|t.k!=K::Ws).map(|t|t.s.as_str()).collect(); assert_eq!(got,original,"token validation failed"); assert_eq!(lf,source.matches('\n').count(),"LF validation failed");
    println!("original bytes={} chars={} LF={}\nencoded visible chars={} compression ratio={:.4}",source.as_bytes().len(),source.chars().count(),lf,visible,visible as f64/source.chars().count() as f64);
}
