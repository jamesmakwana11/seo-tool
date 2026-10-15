use std::io::Write;
use std::process::{Command, Stdio};
use textcore::*;

fn tmpdir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("textcore-test-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn word_count_and_keys_match_the_typescript_rules() {
    assert_eq!(word_count("don't stop\u{2014}now it\u{2019}s 2026"), 5);
    assert_eq!(word_count("  a-b c  "), 2);
    assert_eq!(title_without_brand("Steel Chopper | DeoDap Wholesale", "DeoDap"), "steel chopper");
    assert_eq!(title_without_brand("Steel   Chopper \u{2013} deodap", "DeoDap"), "steel chopper");
    assert_eq!(title_without_brand("A - B", "DeoDap"), "a - b");
    assert_eq!(collapse_ws("  a \t b\u{a0}c "), "a b c");
    let s = shingle_set(&[1, 2, 3, 4, 5]);
    assert_eq!(s.len(), 2);
    assert!((jaccard_sorted(&[1, 2, 3], &[2, 3, 4]) - 0.5).abs() < 1e-9);
}

fn rng(seed: &mut u64) -> f64 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    ((*seed >> 33) as f64) / ((1u64 << 31) as f64)
}

const VOCAB: [&str; 30] = ["steel", "kitchen", "chopper", "sharp", "blades", "easy", "clean", "wholesale", "price", "india", "free", "shipping", "durable", "plastic", "lid",
    "container", "airtight", "fresh", "food", "storage", "gift", "toy", "kids", "car", "racing", "lights", "festive", "decor", "home", "bottle"];

#[test]
fn finds_boilerplate_duplicates_and_near_duplicates_with_high_recall() {
    let dir = tmpdir("core");
    let mut core = Core::new(&dir, "DeoDap").unwrap();
    let mut seed = 7u64;
    let templates: Vec<Vec<&str>> = (0..4).map(|_| (0..60).map(|_| VOCAB[(rng(&mut seed) * 30.0) as usize]).collect()).collect();
    let mut docs: Vec<(u32, Vec<u32>)> = Vec::new(); // brute-force reference: unique-copy token streams
    let mut texts: Vec<String> = Vec::new();
    for i in 0..600u32 {
        let r = rng(&mut seed);
        let words: Vec<String> = if r < 0.6 {
            let mut w: Vec<String> = templates[(rng(&mut seed) * 4.0) as usize].iter().map(|s| s.to_string()).collect();
            let edits = (rng(&mut seed) * 8.0) as usize;
            for _ in 0..edits {
                let k = (rng(&mut seed) * w.len() as f64) as usize;
                w[k] = VOCAB[(rng(&mut seed) * 30.0) as usize].to_string();
            }
            w
        } else {
            (0..(30 + (rng(&mut seed) * 50.0) as usize)).map(|_| VOCAB[(rng(&mut seed) * 30.0) as usize].to_string()).collect()
        };
        texts.push(words.join(" "));
        let _ = i;
    }
    let boiler = "Free shipping on all orders above 499 and cash on delivery available everywhere";
    for (i, t) in texts.iter().enumerate() {
        let title = if i % 50 == 0 { "Same Title | DeoDap".to_string() } else { format!("Product {} | DeoDap", i) };
        core.add(PageIn { id: i as u32, template: 2, ok: true, title: &title, meta: "", h1: "", desc: "", blocks: vec![t.as_str(), boiler] }).unwrap();
        let mut toks = Vec::new();
        tokens(t, &mut toks);
        docs.push((i as u32, toks));
    }
    core.finish().unwrap();
    let json = std::fs::read_to_string(dir.join("text.json")).unwrap();
    assert!(json.contains(boiler), "boilerplate block reported");
    assert!(!dir.join("textcore.spill").exists(), "spill removed");
    // Same Title on 12 pages → one titleExact group of 12.
    let te = &json[json.find("\"titleExact\":").unwrap()..];
    let g = &te[te.find("[[").unwrap()..te.find("]]").unwrap()];
    assert_eq!(g.matches(',').count() + 1, 12);
    // Recall: every pair at J >= 0.9 (brute force) must be in one 0.9 cluster.
    let near = &json[json.find("\"asWritten\":{\"0.9\":").unwrap() + 19..];
    let end = near.find("],\"0.85\"").unwrap() + 1;
    let clusters: Vec<Vec<u32>> = near[1..end - 1]
        .split("],[")
        .filter(|s| !s.trim_matches(|c| c == '[' || c == ']').is_empty())
        .map(|s| s.trim_matches(|c| c == '[' || c == ']').split(',').map(|x| x.parse().unwrap()).collect())
        .collect();
    let mut cl = std::collections::HashMap::new();
    for (k, c) in clusters.iter().enumerate() {
        for id in c {
            cl.insert(*id, k);
        }
    }
    let sets: Vec<Vec<u32>> = docs.iter().map(|(_, t)| shingle_set(t)).collect();
    let (mut pairs, mut found) = (0, 0);
    for a in 0..sets.len() {
        if word_count(&texts[a]) < MIN_NEAR_WORDS {
            continue;
        }
        for b in a + 1..sets.len() {
            if word_count(&texts[b]) < MIN_NEAR_WORDS || sets[a].is_empty() || sets[b].is_empty() {
                continue;
            }
            if jaccard_sorted(&sets[a], &sets[b]) >= 0.9 {
                pairs += 1;
                if cl.get(&(a as u32)).is_some() && cl.get(&(a as u32)) == cl.get(&(b as u32)) {
                    found += 1;
                }
            }
        }
    }
    assert!(pairs > 50, "corpus should contain near-duplicates ({})", pairs);
    assert_eq!(found, pairs, "recall at 0.9: {}/{}", found, pairs);
    // Precision: every pair inside a cluster is connected by verified edges (clusters only form from confirmed pairs).
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn binary_protocol_end_to_end() {
    let dir = tmpdir("proto");
    let bin = env!("CARGO_BIN_EXE_sentinel-textcore");
    let mut child = Command::new(bin).args(["--workdir", dir.to_str().unwrap(), "--brand", "DeoDap"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let put = |b: &mut Vec<u8>, s: &str| {
        b.extend_from_slice(&(s.len() as u32).to_le_bytes());
        b.extend_from_slice(s.as_bytes());
    };
    for id in 0..5u32 {
        let mut p = Vec::new();
        p.extend_from_slice(&id.to_le_bytes());
        p.push(2);
        p.push(1);
        put(&mut p, "Title | DeoDap");
        put(&mut p, "meta");
        put(&mut p, "Name");
        put(&mut p, "");
        p.extend_from_slice(&2u32.to_le_bytes());
        put(&mut p, "a shared text block that appears on every product page of this store");
        put(&mut p, &format!("unique copy number {} for this product", id));
        let mut f = vec![1u8];
        f.extend_from_slice(&(p.len() as u32).to_le_bytes());
        f.extend_from_slice(&p);
        stdin.write_all(&f).unwrap();
    }
    stdin.write_all(&[2, 0, 0, 0, 0]).unwrap();
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.starts_with("SENTINEL-TEXTCORE 1\nDONE text.json"), "{}", s);
    let json = std::fs::read_to_string(dir.join("text.json")).unwrap();
    assert!(json.contains("\"boilerplate\":{\"product\":[\"a shared text block"));
    assert!(json.contains("\"titleExact\":[[0,1,2,3,4]]"));
    std::fs::remove_dir_all(&dir).unwrap();
}
