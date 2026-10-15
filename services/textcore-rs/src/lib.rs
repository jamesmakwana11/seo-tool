//! DeoDap SEO Sentinel text core.
//!
//! Receives page text from the Go crawler (one long-lived process per crawl) and computes, without keeping page text
//! in memory:
//!  * groups of pages sharing a title / meta description / H1 (normalised exactly like the TypeScript analyzers);
//!  * template boilerplate: text blocks repeated on at least half of a template's pages (and on at least 3);
//!  * per page: words of unique copy (blocks that are not template boilerplate);
//!  * exact duplicate content: pages whose unique copy is identical;
//!  * near-duplicate content: Jaccard similarity of 4-word shingle sets of the unique copy, found with MinHash/LSH
//!    candidates and **confirmed by computing the exact Jaccard** of the two sets (candidates that fail are dropped),
//!    both as written and with the page's H1 masked (fill-in-the-blank copy).
//!
//! Page token streams are spilled to a file in the crawl's work directory; memory holds only hashes and signatures.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const TEMPLATES: [&str; 8] = ["home", "collection", "product", "blog_article", "blog_index", "page", "search", "other"];

// ------------------------------------------------------------------------------------------------ hashing

pub fn fnv64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub fn mix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

// ------------------------------------------------------------------------------------------------ text

/// JavaScript `\s` (the characters String.prototype.trim and /\s/ treat as white space).
pub fn is_js_space(c: char) -> bool {
    matches!(c as u32, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// Collapse runs of white space to one space and trim.
pub fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if is_js_space(c) {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    out
}

fn is_word_start(c: char) -> bool {
    c.is_alphanumeric()
}
fn is_word_cont(c: char) -> bool {
    c.is_alphanumeric() || c == '\'' || c == '\u{2019}' || c == '-'
}

/// Word count with the rules of the shared TypeScript `wordCount` (letters/digits, joined by ' ’ -).
pub fn word_count(s: &str) -> u32 {
    let mut n = 0;
    let mut inw = false;
    for c in s.chars() {
        if inw {
            if is_word_cont(c) {
                continue;
            }
            inw = false;
        }
        if is_word_start(c) {
            inw = true;
            n += 1;
        }
    }
    n
}

/// Lower-cased letter/digit runs as 32-bit token hashes (the shingle tokeniser of the TypeScript `shingles`).
pub fn tokens(s: &str, out: &mut Vec<u32>) {
    let mut cur = String::new();
    let flush = |cur: &mut String, out: &mut Vec<u32>| {
        if !cur.is_empty() {
            out.push((mix64(fnv64(cur.as_bytes())) & 0xffff_ffff) as u32);
            cur.clear();
        }
    };
    for c in s.chars() {
        if c.is_alphanumeric() {
            for l in c.to_lowercase() {
                cur.push(l);
            }
        } else {
            flush(&mut cur, out);
        }
    }
    flush(&mut cur, out);
}

/// TECH-DUPLICATE title key: lower-case, " | Brand…" suffix removed, white space collapsed.
pub fn title_without_brand(title: &str, brand: &str) -> String {
    let lower = title.to_lowercase();
    let b = brand.to_lowercase();
    let chars: Vec<(usize, char)> = lower.char_indices().collect();
    let mut cut: Option<usize> = None;
    if !b.is_empty() {
        for (k, &(i, c)) in chars.iter().enumerate() {
            if !matches!(c, '|' | '\u{2013}' | '\u{2014}' | ':' | '-') {
                continue;
            }
            // after the separator: optional white space then the brand
            let mut j = i + c.len_utf8();
            let rest = &lower[j..];
            let skipped = rest.len() - rest.trim_start_matches(is_js_space).len();
            j += skipped;
            if lower[j..].starts_with(&b) {
                // leftmost match starts at the white space run before the separator
                let mut start = i;
                let mut kk = k;
                while kk > 0 && is_js_space(chars[kk - 1].1) {
                    kk -= 1;
                    start = chars[kk].0;
                }
                cut = Some(start);
                break;
            }
        }
    }
    let base = match cut {
        Some(c) => &lower[..c],
        None => &lower[..],
    };
    collapse_ws(base)
}

// ------------------------------------------------------------------------------------------------ union-find

pub struct Uf {
    parent: Vec<u32>,
}
impl Uf {
    pub fn new(n: usize) -> Self {
        Uf { parent: (0..n as u32).collect() }
    }
    pub fn find(&mut self, x: u32) -> u32 {
        let mut r = x;
        while self.parent[r as usize] != r {
            r = self.parent[r as usize];
        }
        let mut y = x;
        while self.parent[y as usize] != r {
            let n = self.parent[y as usize];
            self.parent[y as usize] = r;
            y = n;
        }
        r
    }
    pub fn union(&mut self, a: u32, b: u32) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[ra as usize] = rb;
        }
    }
}

/// Exact Jaccard of two sorted, de-duplicated sets.
pub fn jaccard_sorted(a: &[u32], b: &[u32]) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let (mut i, mut j, mut inter) = (0, 0, 0usize);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            inter += 1;
            i += 1;
            j += 1;
        } else if a[i] < b[j] {
            i += 1;
        } else {
            j += 1;
        }
    }
    inter as f64 / (a.len() + b.len() - inter) as f64
}

/// 4-token shingles of a token stream as a sorted, de-duplicated set of 32-bit hashes.
pub fn shingle_set(toks: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(toks.len().saturating_sub(3));
    if toks.len() >= 4 {
        for w in toks.windows(4) {
            let h = mix64(((w[0] as u64) << 32 | w[1] as u64) ^ mix64((w[2] as u64) << 32 | w[3] as u64));
            out.push((h & 0xffff_ffff) as u32);
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

pub const MINHASH: usize = 64;
pub const BANDS: usize = 16;
pub const ROWS: usize = 4;

pub fn minhash(set: &[u32], seeds: &[u64; MINHASH]) -> [u32; MINHASH] {
    let mut sig = [u32::MAX; MINHASH];
    for &x in set {
        for (k, s) in seeds.iter().enumerate() {
            let h = (mix64(x as u64 ^ s) & 0xffff_ffff) as u32;
            if h < sig[k] {
                sig[k] = h;
            }
        }
    }
    sig
}

pub fn seeds() -> [u64; MINHASH] {
    let mut s = [0u64; MINHASH];
    let mut z = 0x5eed_1234_abcd_0001u64;
    for v in s.iter_mut() {
        z = mix64(z);
        *v = z;
    }
    s
}

// ------------------------------------------------------------------------------------------------ JSON output

pub fn json_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn json_groups(groups: &[Vec<u32>], out: &mut String) {
    out.push('[');
    for (i, g) in groups.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        for (k, id) in g.iter().enumerate() {
            if k > 0 {
                out.push(',');
            }
            out.push_str(&id.to_string());
        }
        out.push(']');
    }
    out.push(']');
}

// ------------------------------------------------------------------------------------------------ the core

pub struct PageIn<'a> {
    pub id: u32,
    pub template: u8,
    pub ok: bool,
    pub title: &'a str,
    pub meta: &'a str,
    pub h1: &'a str,
    pub desc: &'a str,
    pub blocks: Vec<&'a str>,
}

struct PageMeta {
    id: u32,
    template: u8,
    ok: bool,
    offset: u64,
}

pub const THRESHOLDS: [f64; 4] = [0.9, 0.85, 0.8, 0.75];
/// Near-duplicate comparison variants (see Core::finish).
pub const VARIANTS: [&str; 3] = ["asWritten", "h1Masked", "descMasked"];

/// One page taking part in near-duplicate comparison: per variant, its shingle set's place in the sets file and its
/// LSH band keys (length 0 = the page is not compared in that variant).
struct NearDoc {
    page: u32,
    off: [u64; 3],
    len: [u32; 3],
    bands: [[u64; BANDS]; 3],
}

/// Replaces every occurrence of the H1's token sequence with one placeholder token.
pub fn mask_tokens(toks: &[u32], mask: &[u32]) -> Vec<u32> {
    if mask.is_empty() {
        return toks.to_vec();
    }
    let mut out = Vec::with_capacity(toks.len());
    let mut i = 0;
    while i < toks.len() {
        if i + mask.len() <= toks.len() && toks[i..i + mask.len()] == mask[..] {
            out.push(0x5052_4f44); // "PROD"
            i += mask.len();
        } else {
            out.push(toks[i]);
            i += 1;
        }
    }
    out
}
/// Pages with fewer words of unique copy are not compared for near-duplicates.
pub const MIN_NEAR_WORDS: u32 = 25;
/// Representatives compared per LSH bucket (bounds the work for very large groups of identical pages).
pub const MAX_REPS: usize = 24;

pub struct Core {
    brand: String,
    workdir: PathBuf,
    spill: BufWriter<File>,
    spill_pos: u64,
    pages: Vec<PageMeta>,
    groups: [HashMap<u64, Vec<u32>>; 6],
    block_counts: Vec<HashMap<u64, u32>>,
    block_text: HashMap<u64, String>,
    ok_per_template: [u32; 8],
    scratch: Vec<u32>,
    pub bytes_in: u64,
}

pub struct Stats {
    pub pages: usize,
    pub ms: u128,
    pub candidate_pairs: u64,
    pub verified_pairs: u64,
    pub spill_bytes: u64,
}

impl Core {
    pub fn new(workdir: &Path, brand: &str) -> std::io::Result<Self> {
        let spill = BufWriter::with_capacity(1 << 20, File::create(workdir.join("textcore.spill"))?);
        Ok(Core {
            brand: brand.to_string(),
            workdir: workdir.to_path_buf(),
            spill,
            spill_pos: 0,
            pages: Vec::new(),
            groups: Default::default(),
            block_counts: (0..8).map(|_| HashMap::new()).collect(),
            block_text: HashMap::new(),
            ok_per_template: [0; 8],
            scratch: Vec::new(),
            bytes_in: 0,
        })
    }

    fn group(&mut self, kind: usize, key: &str, id: u32) {
        if key.is_empty() {
            return;
        }
        self.groups[kind].entry(fnv64(key.as_bytes())).or_default().push(id);
    }

    fn w32(&mut self, v: u32) -> std::io::Result<()> {
        self.spill.write_all(&v.to_le_bytes())?;
        self.spill_pos += 4;
        Ok(())
    }
    fn w64(&mut self, v: u64) -> std::io::Result<()> {
        self.spill.write_all(&v.to_le_bytes())?;
        self.spill_pos += 8;
        Ok(())
    }

    pub fn add(&mut self, p: PageIn) -> std::io::Result<()> {
        let t = (p.template as usize).min(7);
        // Duplicate-text groups (keys exactly as the TypeScript analyzers build them).
        let title = js_trim(&p.title.to_lowercase()).to_string();
        self.group(0, &title, p.id); // ONP-TITLE: lower-case + trim
        // Per-template keys: an empty value is "missing", never a duplicate (same as the TypeScript `|| undefined`).
        let tb = title_without_brand(p.title, &self.brand);
        if !tb.is_empty() {
            self.group(1, &format!("{}\u{0}{}", t, tb), p.id); // TECH-DUPLICATE title (per template)
        }
        let meta_lower = p.meta.to_lowercase();
        self.group(2, js_trim(&meta_lower), p.id); // ONP-META: lower-case + trim
        if !meta_lower.is_empty() {
            self.group(3, &format!("{}\u{0}{}", t, meta_lower), p.id); // TECH-DUPLICATE meta (per template)
        }
        let (h1, multi) = match p.h1.find('\u{0}') {
            Some(i) => (&p.h1[..i], true),
            None => (p.h1, false),
        };
        let h1l = h1.to_lowercase();
        if !multi && !h1.is_empty() && t != 0 {
            self.group(4, &h1l, p.id); // ONP-H1: single H1, home excluded
        }
        if !h1l.is_empty() {
            self.group(5, &format!("{}\u{0}{}", t, h1l), p.id); // TECH-DUPLICATE first H1 (per template)
        }

        // Spill: id, template, flags, H1 mask tokens, blocks (hash, words, tokens).
        let offset = self.spill_pos;
        self.w32(p.id)?;
        self.spill.write_all(&[t as u8, p.ok as u8])?;
        self.spill_pos += 2;
        let mut mask = std::mem::take(&mut self.scratch);
        mask.clear();
        tokens(h1, &mut mask);
        self.w32(mask.len() as u32)?;
        for &m in &mask {
            self.w32(m)?;
        }
        self.w32(p.blocks.len() as u32)?;
        let mut seen: Vec<u64> = Vec::with_capacity(p.blocks.len());
        for b in &p.blocks {
            self.bytes_in += b.len() as u64;
            let h = fnv64(b.as_bytes()) ^ (b.len() as u64).wrapping_mul(0x9e37_79b9);
            mask.clear();
            tokens(b, &mut mask);
            self.w64(h)?;
            self.w32(word_count(b))?;
            self.w32(mask.len() as u32)?;
            for &k in &mask {
                self.w32(k)?;
            }
            if p.ok && !seen.contains(&h) {
                seen.push(h);
                let c = self.block_counts[t].entry(h).or_insert(0);
                *c += 1;
                if *c == 2 {
                    self.block_text.entry(h).or_insert_with(|| b.to_string());
                }
            }
        }
        // The product / collection description (AIC-01 compares it, H1-masked; all blocks when there is none).
        mask.clear();
        tokens(p.desc, &mut mask);
        self.w32(word_count(p.desc))?;
        self.w32(mask.len() as u32)?;
        for &k in &mask {
            self.w32(k)?;
        }
        self.scratch = mask;
        if p.ok {
            self.ok_per_template[t] += 1;
        }
        self.pages.push(PageMeta { id: p.id, template: t as u8, ok: p.ok, offset });
        Ok(())
    }

    /// Computes everything and writes text.json. Returns statistics.
    pub fn finish(mut self) -> std::io::Result<Stats> {
        let t0 = std::time::Instant::now();
        self.spill.flush()?;
        let spill_path = self.workdir.join("textcore.spill");
        let spill_bytes = self.spill_pos;
        // 1. Template boilerplate.
        let mut boiler: Vec<std::collections::HashSet<u64>> = (0..8).map(|_| Default::default()).collect();
        for t in 0..8 {
            let n = self.ok_per_template[t];
            if n < 3 {
                continue;
            }
            let min = 3u32.max((n as f64 * 0.5).ceil() as u32);
            for (h, c) in &self.block_counts[t] {
                if *c >= min {
                    boiler[t].insert(*h);
                }
            }
        }
        self.block_counts.clear();
        // 2. Per page: unique words, exact unique-copy hash, and per comparison variant a shingle set (to a second spill)
        //    with its LSH band keys. Variants: 0 = unique copy as written, 1 = unique copy with the H1 masked,
        //    2 = the description (all own blocks when there is none) with the H1 masked.
        let seeds = seeds();
        let mut f = std::io::BufReader::with_capacity(1 << 20, File::open(&spill_path)?);
        let sets_path = self.workdir.join("textcore.sets");
        let mut sets_w = BufWriter::with_capacity(1 << 20, File::create(&sets_path)?);
        let mut sets_pos: u64 = 0;
        let n = self.pages.len();
        let mut unique_words = vec![0u32; n];
        let mut unique_hash = vec![0u64; n];
        let mut near: Vec<NearDoc> = Vec::new();
        let mut toks: Vec<u32> = Vec::new();
        let mut all_toks: Vec<u32> = Vec::new();
        let mut desc_toks: Vec<u32> = Vec::new();
        let rd32 = |f: &mut std::io::BufReader<File>| -> std::io::Result<u32> {
            let mut b = [0u8; 4];
            f.read_exact(&mut b)?;
            Ok(u32::from_le_bytes(b))
        };
        for (pi, pm) in self.pages.iter().enumerate() {
            f.seek(SeekFrom::Start(pm.offset))?;
            let _id = rd32(&mut f)?;
            let mut tb = [0u8; 2];
            f.read_exact(&mut tb)?;
            let nm = rd32(&mut f)? as usize;
            let mut mask = Vec::with_capacity(nm);
            for _ in 0..nm {
                mask.push(rd32(&mut f)?);
            }
            let nb = rd32(&mut f)? as usize;
            toks.clear();
            all_toks.clear();
            let mut words = 0u32;
            let mut all_words = 0u32;
            let mut uh: u64 = 0xcbf2_9ce4_8422_2325;
            for _ in 0..nb {
                let mut hb = [0u8; 8];
                f.read_exact(&mut hb)?;
                let h = u64::from_le_bytes(hb);
                let wc = rd32(&mut f)?;
                let nt = rd32(&mut f)? as usize;
                let keep = !boiler[pm.template as usize].contains(&h);
                for _ in 0..nt {
                    let tk = rd32(&mut f)?;
                    all_toks.push(tk);
                    if keep {
                        toks.push(tk);
                    }
                }
                all_words += wc;
                if keep {
                    words += wc;
                    uh = mix64(uh ^ h);
                }
            }
            let dwc = rd32(&mut f)?;
            let nd = rd32(&mut f)? as usize;
            desc_toks.clear();
            for _ in 0..nd {
                desc_toks.push(rd32(&mut f)?);
            }
            unique_words[pi] = words;
            unique_hash[pi] = uh;
            if !pm.ok {
                continue;
            }
            let unique_ok = words >= MIN_NEAR_WORDS;
            let (base, base_words) = if nd > 0 { (&desc_toks, dwc) } else { (&all_toks, all_words) };
            let desc_ok = base_words >= MIN_NEAR_WORDS;
            if !unique_ok && !desc_ok {
                continue;
            }
            let sets: [Vec<u32>; 3] = [
                if unique_ok { shingle_set(&toks) } else { Vec::new() },
                if unique_ok { shingle_set(&mask_tokens(&toks, &mask)) } else { Vec::new() },
                if desc_ok { shingle_set(&mask_tokens(base, &mask)) } else { Vec::new() },
            ];
            if sets.iter().all(|x| x.is_empty()) {
                continue;
            }
            let mut doc = NearDoc { page: pi as u32, off: [0; 3], len: [0; 3], bands: [[0; BANDS]; 3] };
            for (v, set) in sets.iter().enumerate() {
                if set.is_empty() {
                    continue;
                }
                doc.off[v] = sets_pos;
                doc.len[v] = set.len() as u32;
                sets_w.write_all(&(set.len() as u32).to_le_bytes())?;
                for x in set.iter() {
                    sets_w.write_all(&x.to_le_bytes())?;
                }
                sets_pos += 4 + 4 * set.len() as u64;
                let sig = minhash(set, &seeds);
                for band in 0..BANDS {
                    let mut h = mix64(band as u64 ^ ((pm.template as u64) << 40) ^ ((v as u64) << 48));
                    for r in 0..ROWS {
                        h = mix64(h ^ sig[band * ROWS + r] as u64);
                    }
                    doc.bands[v][band] = h;
                }
            }
            near.push(doc);
        }
        sets_w.flush()?;
        drop(sets_w);
        drop(f);
        // 3. LSH + exact verification, per variant, within a template.
        let mut sets_r = File::open(&sets_path)?;
        let mut cache: HashMap<u64, std::rc::Rc<Vec<u32>>> = HashMap::new();
        let mut load = |off: u64, len: u32, cache: &mut HashMap<u64, std::rc::Rc<Vec<u32>>>| -> std::io::Result<std::rc::Rc<Vec<u32>>> {
            if let Some(v) = cache.get(&off) {
                return Ok(v.clone());
            }
            if cache.len() > 4096 {
                cache.clear();
            }
            sets_r.seek(SeekFrom::Start(off + 4))?;
            let mut buf = vec![0u8; len as usize * 4];
            sets_r.read_exact(&mut buf)?;
            let v: Vec<u32> = buf.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            let rc = std::rc::Rc::new(v);
            cache.insert(off, rc.clone());
            Ok(rc)
        };
        let mut clusters: Vec<Vec<Vec<Vec<u32>>>> = vec![Vec::new(); VARIANTS.len()];
        let mut evidence: Vec<(u32, u32, f64, usize)> = Vec::new();
        let mut candidate_pairs = 0u64;
        let mut verified_pairs = 0u64;
        for v in 0..VARIANTS.len() {
            let m = near.len();
            let mut ufs: Vec<Uf> = THRESHOLDS.iter().map(|_| Uf::new(m)).collect();
            // Identical shingle sets: joined directly.
            let mut exact: HashMap<u64, u32> = HashMap::new();
            for (k, e) in near.iter().enumerate() {
                let (off, len) = (e.off[v], e.len[v]);
                if len == 0 {
                    continue;
                }
                let s = load(off, len, &mut cache)?;
                let mut h = fnv64(&[self.pages[e.page as usize].template]) ^ (len as u64);
                for x in s.iter() {
                    h = mix64(h ^ *x as u64);
                }
                if let Some(&first) = exact.get(&h) {
                    let fe = &near[first as usize];
                    let (fo, fl) = (fe.off[v], fe.len[v]);
                    if fl == len && *load(fo, fl, &mut cache)? == *s {
                        for uf in ufs.iter_mut() {
                            uf.union(k as u32, first);
                        }
                        continue;
                    }
                }
                exact.insert(h, k as u32);
            }
            cache.clear();
            for band in 0..BANDS {
                let mut keys: Vec<(u64, u32)> = Vec::with_capacity(m);
                for (k, e) in near.iter().enumerate() {
                    if e.len[v] == 0 {
                        continue;
                    }
                    keys.push((e.bands[v][band], k as u32));
                }
                keys.sort_unstable();
                let mut i = 0;
                while i < keys.len() {
                    let mut j = i + 1;
                    while j < keys.len() && keys[j].0 == keys[i].0 {
                        j += 1;
                    }
                    if j - i > 1 {
                        let mut reps: Vec<u32> = Vec::new();
                        for &(_, d) in &keys[i..j] {
                            let mut linked = false;
                            for &r in &reps {
                                if ufs[0].find(d) == ufs[0].find(r) {
                                    linked = true;
                                    break;
                                }
                                candidate_pairs += 1;
                                let (ed, er) = (&near[d as usize], &near[r as usize]);
                                let sd = load(ed.off[v], ed.len[v], &mut cache)?;
                                let sr = load(er.off[v], er.len[v], &mut cache)?;
                                let jac = jaccard_sorted(&sd, &sr);
                                if jac >= THRESHOLDS[THRESHOLDS.len() - 1] {
                                    verified_pairs += 1;
                                    if evidence.len() < 2000 {
                                        evidence.push((self.pages[ed.page as usize].id, self.pages[er.page as usize].id, jac, v));
                                    }
                                }
                                for (ti, t) in THRESHOLDS.iter().enumerate() {
                                    if jac >= *t {
                                        ufs[ti].union(d, r);
                                    }
                                }
                                if ufs[0].find(d) == ufs[0].find(r) {
                                    linked = true;
                                    break;
                                }
                            }
                            if !linked && reps.len() < MAX_REPS {
                                reps.push(d);
                            }
                        }
                    }
                    i = j;
                }
            }
            for uf in ufs.iter_mut() {
                let mut by_root: HashMap<u32, Vec<u32>> = HashMap::new();
                let mut order: Vec<u32> = Vec::new();
                for k in 0..m as u32 {
                    if near[k as usize].len[v] == 0 {
                        continue;
                    }
                    let r = uf.find(k);
                    let e = by_root.entry(r).or_insert_with(|| {
                        order.push(r);
                        Vec::new()
                    });
                    e.push(self.pages[near[k as usize].page as usize].id);
                }
                let mut out: Vec<Vec<u32>> = Vec::new();
                for r in order {
                    let g = by_root.remove(&r).unwrap();
                    if g.len() > 1 {
                        out.push(g);
                    }
                }
                clusters[v].push(out);
            }
        }
        // 4. Exact duplicate unique copy (ok pages with some unique words).
        let mut exact_groups: HashMap<u64, Vec<u32>> = HashMap::new();
        for (pi, pm) in self.pages.iter().enumerate() {
            if pm.ok && unique_words[pi] >= 10 {
                exact_groups.entry(unique_hash[pi] ^ ((pm.template as u64) << 56)).or_default().push(pm.id);
            }
        }
        // 5. text.json
        let mut out = String::with_capacity(1 << 16);
        out.push_str("{\"version\":1,\"pages\":");
        out.push_str(&n.to_string());
        out.push_str(",\"unique\":{\"ids\":[");
        for (i, pm) in self.pages.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&pm.id.to_string());
        }
        out.push_str("],\"words\":[");
        for (i, w) in unique_words.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&w.to_string());
        }
        out.push_str("]},\"boilerplate\":{");
        let mut first = true;
        for t in 0..8 {
            if boiler[t].is_empty() {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            json_str(TEMPLATES[t], &mut out);
            out.push_str(":[");
            let mut k = 0;
            for h in &boiler[t] {
                if let Some(txt) = self.block_text.get(h) {
                    if k > 0 {
                        out.push(',');
                    }
                    json_str(txt, &mut out);
                    k += 1;
                }
            }
            out.push(']');
        }
        out.push_str("},\"groups\":{");
        let names = ["titleExact", "titleBrand", "metaExact", "metaRaw", "h1Single", "h1First"];
        for (k, name) in names.iter().enumerate() {
            if k > 0 {
                out.push(',');
            }
            json_str(name, &mut out);
            out.push(':');
            let g: Vec<Vec<u32>> = self.groups[k].values().filter(|v| v.len() > 1).cloned().collect();
            json_groups(&g, &mut out);
        }
        out.push_str("},\"exactContent\":");
        let eg: Vec<Vec<u32>> = exact_groups.into_values().filter(|v| v.len() > 1).collect();
        json_groups(&eg, &mut out);
        out.push_str(",\"near\":{");
        for (v, name) in VARIANTS.iter().enumerate() {
            if v > 0 {
                out.push(',');
            }
            json_str(name, &mut out);
            out.push_str(":{");
            for (ti, t) in THRESHOLDS.iter().enumerate() {
                if ti > 0 {
                    out.push(',');
                }
                json_str(&format!("{}", t), &mut out);
                out.push(':');
                json_groups(&clusters[v][ti], &mut out);
            }
            out.push('}');
        }
        out.push_str("},\"evidence\":[");
        for (i, (a, b, j, v)) in evidence.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!("{{\"a\":{},\"b\":{},\"jaccard\":{:.4},\"variant\":\"{}\"}}", a, b, j, VARIANTS[*v]));
        }
        let ms = t0.elapsed().as_millis();
        out.push_str(&format!(
            "],\"stats\":{{\"ms\":{},\"nearCandidates\":{},\"candidatePairs\":{},\"verifiedPairs\":{},\"spillBytes\":{},\"bytesIn\":{},\"minNearWords\":{},\"thresholds\":[0.9,0.85,0.8,0.75],\"maxRepsPerBucket\":{}}}}}",
            ms, near.len(), candidate_pairs, verified_pairs, spill_bytes, self.bytes_in, MIN_NEAR_WORDS, MAX_REPS
        ));
        let tmp = self.workdir.join("text.json.tmp");
        std::fs::write(&tmp, out.as_bytes())?;
        std::fs::rename(&tmp, self.workdir.join("text.json"))?;
        let _ = std::fs::remove_file(&spill_path);
        let _ = std::fs::remove_file(&sets_path);
        Ok(Stats { pages: n, ms, candidate_pairs, verified_pairs, spill_bytes })
    }
}
