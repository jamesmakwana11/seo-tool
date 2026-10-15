//! sentinel-textcore: long-lived worker driven by the Go crawler over stdin (frame protocol v1, see the Go client in
//! services/crawler-go/textcore.go). Prints "SENTINEL-TEXTCORE 1" when ready and "DONE text.json" after FINISH.

use std::io::{self, BufReader, Read, Write};
use std::path::PathBuf;
use textcore::{Core, PageIn};

fn read_u32(b: &[u8], p: &mut usize) -> Option<u32> {
    if *p + 4 > b.len() {
        return None;
    }
    let v = u32::from_le_bytes([b[*p], b[*p + 1], b[*p + 2], b[*p + 3]]);
    *p += 4;
    Some(v)
}

fn read_str<'a>(b: &'a [u8], p: &mut usize) -> Option<&'a str> {
    let n = read_u32(b, p)? as usize;
    if *p + n > b.len() {
        return None;
    }
    let s = std::str::from_utf8(&b[*p..*p + n]).ok()?;
    *p += n;
    Some(s)
}

fn parse_page(b: &[u8]) -> Option<PageIn<'_>> {
    let mut p = 0;
    let id = read_u32(b, &mut p)?;
    if p + 2 > b.len() {
        return None;
    }
    let template = b[p];
    let flags = b[p + 1];
    p += 2;
    let title = read_str(b, &mut p)?;
    let meta = read_str(b, &mut p)?;
    let h1 = read_str(b, &mut p)?;
    let desc = read_str(b, &mut p)?;
    let nb = read_u32(b, &mut p)? as usize;
    let mut blocks = Vec::with_capacity(nb.min(4096));
    for _ in 0..nb {
        blocks.push(read_str(b, &mut p)?);
    }
    Some(PageIn { id, template, ok: flags & 1 == 1, title, meta, h1, desc, blocks })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("sentinel-textcore {} (protocol 1)", env!("CARGO_PKG_VERSION"));
        return;
    }
    let mut workdir: Option<PathBuf> = None;
    let mut brand = String::new();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--workdir" if i + 1 < args.len() => {
                workdir = Some(PathBuf::from(&args[i + 1]));
                i += 1;
            }
            "--brand" if i + 1 < args.len() => {
                brand = args[i + 1].clone();
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    let Some(workdir) = workdir else {
        eprintln!("usage: sentinel-textcore --workdir <dir> [--brand <brand>]");
        std::process::exit(2);
    };
    let mut core = match Core::new(&workdir, &brand) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cannot open work files in {}: {}", workdir.display(), e);
            std::process::exit(1);
        }
    };
    let stdout = io::stdout();
    {
        let mut o = stdout.lock();
        let _ = writeln!(o, "SENTINEL-TEXTCORE 1");
        let _ = o.flush();
    }
    let mut input = BufReader::with_capacity(1 << 20, io::stdin().lock());
    let mut header = [0u8; 5];
    let mut buf: Vec<u8> = Vec::new();
    loop {
        if let Err(e) = input.read_exact(&mut header) {
            eprintln!("input closed before FINISH: {}", e);
            std::process::exit(3);
        }
        let kind = header[0];
        let len = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
        if len > 256 << 20 {
            eprintln!("frame too large: {} bytes", len);
            std::process::exit(4);
        }
        buf.resize(len, 0);
        if let Err(e) = input.read_exact(&mut buf) {
            eprintln!("truncated frame: {}", e);
            std::process::exit(3);
        }
        match kind {
            1 => match parse_page(&buf) {
                Some(p) => {
                    if let Err(e) = core.add(p) {
                        eprintln!("spill write failed: {}", e);
                        std::process::exit(5);
                    }
                }
                None => {
                    eprintln!("malformed PAGE frame");
                    std::process::exit(4);
                }
            },
            2 => {
                match core.finish() {
                    Ok(s) => {
                        eprintln!("textcore: {} pages, {} candidate pairs, {} verified, {} ms", s.pages, s.candidate_pairs, s.verified_pairs, s.ms);
                        let mut o = stdout.lock();
                        let _ = writeln!(o, "DONE text.json");
                        let _ = o.flush();
                        return;
                    }
                    Err(e) => {
                        eprintln!("finish failed: {}", e);
                        let mut o = stdout.lock();
                        let _ = writeln!(o, "ERROR {}", e);
                        let _ = o.flush();
                        std::process::exit(6);
                    }
                }
            }
            k => {
                eprintln!("unknown frame kind {}", k);
                std::process::exit(4);
            }
        }
    }
}
