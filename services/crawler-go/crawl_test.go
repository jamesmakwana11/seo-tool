package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A generated store: N products in C collections (24 per listing page, ?page=N pagination), a sitemap index with a
// gzip child, robots.txt rules, a redirect, a crawl trap, a facet link, an orphan section reachable only from the
// sitemap, and a URL that answers 429 once.
type site struct {
	products, collections int
	hits                  sync.Map
	once429               atomic.Bool
	delay                 time.Duration
}

func (s *site) count(p string) int {
	v, _ := s.hits.Load(p)
	if v == nil {
		return 0
	}
	return int(v.(*atomic.Int64).Load())
}

func page(title string, links []string, extra string) string {
	var b strings.Builder
	b.WriteString(`<!doctype html><html lang="en"><head><title>` + title + ` | DeoDap</title><meta name="description" content="` + title + ` description text for the page">`)
	b.WriteString(`<link rel="canonical" href="` + extra + `"></head><body><header><nav><a href="/">Home</a><a href="/collections/c0">C0</a></nav></header><main><h1>` + title + `</h1><p>Unique copy about ` + title + ` with enough words to be read as real text on the page.</p>`)
	for _, l := range links {
		b.WriteString(`<a href="` + l + `">` + l + `</a>`)
	}
	b.WriteString(`</main><footer><a href="/pages/about">About</a></footer></body></html>`)
	return b.String()
}

func (s *site) handler(base func() string) http.Handler {
	per := 24
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.RequestURI()
		v, _ := s.hits.LoadOrStore(key, new(atomic.Int64))
		v.(*atomic.Int64).Add(1)
		if s.delay > 0 {
			time.Sleep(s.delay)
		}
		p := r.URL.Path
		html := func(body string) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(body))
		}
		switch {
		case p == "/robots.txt":
			fmt.Fprintf(w, "User-agent: *\nDisallow: /private\nSitemap: %s/sitemap.xml\n", base())
		case p == "/sitemap.xml":
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(w, `<sitemapindex><sitemap><loc>%s/sitemap_products.xml.gz</loc></sitemap><sitemap><loc>%s/sitemap_pages.xml</loc></sitemap></sitemapindex>`, base(), base())
		case p == "/sitemap_products.xml.gz":
			var b bytes.Buffer
			b.WriteString(`<urlset>`)
			for i := 0; i < s.products; i++ {
				fmt.Fprintf(&b, `<url><loc>%s/products/p%d</loc><lastmod>2026-10-01</lastmod></url>`, base(), i)
			}
			b.WriteString(`</urlset>`)
			var gz bytes.Buffer
			zw := gzip.NewWriter(&gz)
			zw.Write(b.Bytes())
			zw.Close()
			w.Header().Set("Content-Type", "application/x-gzip")
			w.Write(gz.Bytes())
		case p == "/sitemap_pages.xml":
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(w, `<urlset><url><loc>%s/pages/about</loc></url><url><loc>%s/pages/hidden</loc></url><url><loc>%s/private/x</loc></url></urlset>`, base(), base(), base())
		case p == "/":
			links := []string{"/collections/all-old", "/loop/x/", "/collections/c0?sort_by=price"}
			for c := 0; c < s.collections; c++ {
				links = append(links, fmt.Sprintf("/collections/c%d", c))
			}
			html(page("Home", links, base()+"/"))
		case p == "/collections/all-old":
			http.Redirect(w, r, "/collections/c0", http.StatusMovedPermanently)
		case strings.HasPrefix(p, "/loop/"):
			html(page("Loop", []string{"x/"}, base()+p))
		case strings.HasPrefix(p, "/collections/c"):
			var c, pg int
			fmt.Sscanf(p, "/collections/c%d", &c)
			pg = 1
			fmt.Sscanf(r.URL.Query().Get("page"), "%d", &pg)
			if c >= s.collections {
				http.NotFound(w, r)
				return
			}
			// products i with i % collections == c, 24 per page
			var mine []int
			for i := c; i < s.products; i += s.collections {
				mine = append(mine, i)
			}
			var links []string
			for k := (pg - 1) * per; k < pg*per && k < len(mine); k++ {
				links = append(links, fmt.Sprintf("/products/p%d", mine[k]))
			}
			next := ""
			if pg*per < len(mine) {
				next = fmt.Sprintf(`<link rel="next" href="?page=%d">`, pg+1)
				links = append(links, fmt.Sprintf("?page=%d", pg+1))
			}
			body := page(fmt.Sprintf("Collection %d page %d", c, pg), links, base()+r.URL.RequestURI())
			html(strings.Replace(body, "</head>", next+"</head>", 1))
		case strings.HasPrefix(p, "/products/p"):
			var i int
			fmt.Sscanf(p, "/products/p%d", &i)
			if i >= s.products {
				http.NotFound(w, r)
				return
			}
			if i == 3 && s.once429.CompareAndSwap(false, true) {
				w.Header().Set("Retry-After", "0")
				w.WriteHeader(429)
				return
			}
			html(page(fmt.Sprintf("Product %d", i), []string{fmt.Sprintf("/products/p%d", (i+1)%s.products)}, base()+p))
		case p == "/pages/about":
			html(page("About", nil, base()+p))
		case p == "/pages/hidden":
			html(page("Hidden", []string{"/pages/deeper"}, base()+p))
		case p == "/pages/deeper":
			html(page("Deeper", nil, base()+p))
		default:
			http.NotFound(w, r)
		}
	})
}

type result struct {
	done   map[string]any
	pages  []map[string]any
	urls   []map[string]any
	events []map[string]any
	ctx    map[string]any
}

func readGz(t *testing.T, path string) []map[string]any {
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gzip %s: %v", path, err)
	}
	var out []map[string]any
	sc := bufio.NewScanner(zr)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("bad record: %v", err)
		}
		out = append(out, m)
	}
	return out
}

func crawl(t *testing.T, s *site, job Job, during func(c *Crawler)) result {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(s.handler(func() string { return srv.URL }))
	defer srv.Close()
	dir := t.TempDir()
	job.WorkDir = dir
	job.StartURL = srv.URL + "/"
	job.BaseURL = srv.URL + "/"
	job.AllowLoopback = true
	job.RespectRobots = true
	job.SkipTLS = true
	job.TextCore.Disabled = job.TextCore.Bin == ""
	if job.MaxDepth == 0 {
		job.MaxDepth = -1
	}
	job.ProgressMs = 100
	var buf safeBuf
	ev := &emitter{w: bufio.NewWriter(&buf)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c, err := newCrawler(ctx, cancel, job, ev)
	if err != nil {
		t.Fatal(err)
	}
	if during != nil {
		go during(c)
	}
	if code := c.run(); code != 0 {
		t.Fatalf("exit %d: %s", code, buf.String())
	}
	var r result
	for _, l := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) == nil {
			r.events = append(r.events, m)
			if m["type"] == "done" {
				r.done = m
			}
		}
	}
	r.pages = readGz(t, filepath.Join(dir, "pages.ndjson.gz"))
	r.urls = readGz(t, filepath.Join(dir, "urls.ndjson.gz"))
	b, _ := os.ReadFile(filepath.Join(dir, "context.json"))
	json.Unmarshal(b, &r.ctx)
	return r
}

type safeBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *safeBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *safeBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

func byPath(pages []map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, p := range pages {
		u := p["url"].(string)
		i := strings.Index(u[8:], "/")
		out[u[8+i:]] = p
	}
	return out
}

func TestFullCrawlDiscoversEverythingAndReportsCoverage(t *testing.T) {
	s := &site{products: 300, collections: 4}
	r := crawl(t, s, Job{Mode: "full", Concurrency: 8, TimeoutMs: 5000, Retries: 2}, nil)
	if r.done["state"] != "completed" {
		t.Fatalf("state %v %v", r.done["state"], r.done["reason"])
	}
	pp := byPath(r.pages)
	for i := 0; i < 300; i++ {
		p := pp[fmt.Sprintf("/products/p%d", i)]
		if p == nil || p["finalStatus"].(float64) != 200 {
			t.Fatalf("product %d missing or failed: %v", i, p)
		}
	}
	// 429 retried and then fetched; page fetched exactly once more.
	if s.count("/products/p3") != 2 {
		t.Errorf("p3 requested %d times", s.count("/products/p3"))
	}
	// Pagination followed (75 products per collection → 4 listing pages).
	if pp["/collections/c0?page=4"] == nil || pp["/collections/c0?page=4"]["paginated"] != true {
		t.Error("pagination page 4 not crawled as paginated")
	}
	// Sitemap-only page and its link were crawled; robots-blocked sitemap URL recorded, never requested.
	if pp["/pages/hidden"] == nil || pp["/pages/deeper"] == nil || pp["/pages/hidden"]["reason"] != "sitemap" {
		t.Error("sitemap-only section")
	}
	if pp["/private/x"] == nil || pp["/private/x"]["skippedByRobots"] != true || s.count("/private/x") != 0 {
		t.Error("robots")
	}
	// Redirect recorded + derived page not re-fetched.
	if red := pp["/collections/all-old"]; red == nil || red["status"].(float64) != 301 {
		t.Error("redirect record")
	}
	// Fetched once as a page; following the /collections/all-old redirect requests it once more.
	if s.count("/collections/c0") > 2 {
		t.Errorf("c0 fetched %d times", s.count("/collections/c0"))
	}
	// Facet link: not crawled as a page by discovery (fetched at most once as a crawl-budget sample).
	if s.count("/collections/c0?sort_by=price") > 1 {
		t.Error("facet followed")
	}
	// Trap loop stopped.
	if s.count("/loop/x/x/x/") != 0 {
		t.Error("trap followed")
	}
	states := map[string]int{}
	reasons := map[string]int{}
	for _, u := range r.urls {
		states[u["state"].(string)]++
		if rr, ok := u["reason"].(string); ok {
			reasons[rr]++
		}
	}
	if f := pp["/collections/c0?sort_by=price"]; f == nil || f["budgetSample"] == nil {
		t.Error("facet URL should be fetched once as a crawl-budget sample")
	}
	if states["queued"] != 0 || states["not_processed"] != 0 || states["robots"] != 1 || reasons["crawl_trap"] < 1 {
		t.Errorf("states %v reasons %v", states, reasons)
	}
	counts := r.done["counts"].(map[string]any)
	if counts["processed"].(float64) < 300 || counts["robots"].(float64) != 1 {
		t.Errorf("counts %v", counts)
	}
	sm := r.ctx["sitemap"].(map[string]any)
	if sm["entries"].(float64) != 303 || len(sm["files"].([]any)) != 3 {
		t.Errorf("sitemap %v", sm)
	}
	// Depth is the shortest click depth: home 0 → collection 1 → product 2 (first listing page).
	if d := pp["/products/p0"]["depth"]; d == nil || d.(float64) != 2 {
		t.Errorf("depth p0 %v", d)
	}
	if _, ok := r.ctx["linkTargets"]; !ok {
		t.Error("link targets not checked")
	}
}

func TestPageLimitIsPartialAndCancelKeepsResults(t *testing.T) {
	s := &site{products: 200, collections: 2}
	r := crawl(t, s, Job{Mode: "full", Concurrency: 4, TimeoutMs: 5000, MaxPages: 40}, nil)
	counts := r.done["counts"].(map[string]any)
	if r.done["state"] != "partial" || counts["pageLimited"].(float64) == 0 || counts["processed"].(float64) > 41 {
		t.Fatalf("limit: %v %v", r.done["state"], counts)
	}
	s2 := &site{products: 400, collections: 2, delay: 5 * time.Millisecond}
	r2 := crawl(t, s2, Job{Mode: "full", Concurrency: 2, TimeoutMs: 5000, RequestDelayMs: 5}, func(c *Crawler) {
		for {
			time.Sleep(20 * time.Millisecond)
			c.mu.Lock()
			n := c.processed
			c.mu.Unlock()
			if n >= 30 {
				c.stop("user")
				return
			}
		}
	})
	c2 := r2.done["counts"].(map[string]any)
	if r2.done["state"] != "cancelled" || c2["notProcessed"].(float64) == 0 || len(r2.pages) < 30 {
		t.Fatalf("cancel: %v %v pages=%d", r2.done["state"], c2, len(r2.pages))
	}
}

func TestSmartCrawlPrioritisesAndReportsUnaudited(t *testing.T) {
	s := &site{products: 300, collections: 5}
	r := crawl(t, s, Job{Mode: "smart", Concurrency: 4, TimeoutMs: 5000, MaxPages: 30, Seeds: []Seed{{URL: "http://placeholder/", Reason: "reverify", Priority: 900}}}, nil)
	if r.done["state"] != "partial" {
		t.Fatalf("smart state %v", r.done["state"])
	}
	pp := byPath(r.pages)
	if pp["/"] == nil {
		t.Fatal("homepage first")
	}
	cols := 0
	for p := range pp {
		if strings.HasPrefix(p, "/collections/c") && !strings.Contains(p, "?") {
			cols++
		}
	}
	if cols < 5 {
		t.Errorf("smart crawl should take every collection first, got %d", cols)
	}
	if r.done["counts"].(map[string]any)["pageLimited"].(float64) < 200 {
		t.Error("not-audited URLs must be reported")
	}
}

// TestLargeSiteThroughputAndMemory: a 25,000-product generated site crawled end to end (local server, no delay).
// Set STRESS_GO=50000 for a larger run.
func TestLargeSiteThroughputAndMemory(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	n := 25000
	if v := os.Getenv("STRESS_GO"); v != "" {
		fmt.Sscanf(v, "%d", &n)
	}
	s := &site{products: n, collections: 50}
	var peak float64
	t0 := time.Now()
	r := crawl(t, s, Job{Mode: "full", Concurrency: 16, TimeoutMs: 10000, MemoryLimitMB: 200, Needs: []string{"robots", "sitemap", "linkTargets"}}, func(c *Crawler) {
		for !c.stopped() {
			time.Sleep(200 * time.Millisecond)
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			if v := float64(m.HeapAlloc) / 1048576; v > peak {
				peak = v
			}
			c.mu.Lock()
			fin := c.phase == "finalizing"
			c.mu.Unlock()
			if fin {
				return
			}
		}
	})
	el := time.Since(t0)
	counts := r.done["counts"].(map[string]any)
	if r.done["state"] != "completed" || int(counts["processed"].(float64)) < n {
		t.Fatalf("state %v counts %v", r.done["state"], counts)
	}
	t.Logf("LARGE: products=%d processed=%v seconds=%.1f pagesPerSec=%.0f peakGoHeapMB=%.0f rssMB=%.0f", n, counts["processed"], el.Seconds(), counts["processed"].(float64)/el.Seconds(), peak, rssMB(os.Getpid()))
}

func textCoreBin() string {
	if v := os.Getenv("TEXTCORE_BIN"); v != "" {
		return v
	}
	name := "sentinel-textcore"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	p, _ := filepath.Abs(filepath.Join("..", "textcore-rs", "target", "release", name))
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

func TestGoRustBridge(t *testing.T) {
	bin := textCoreBin()
	if bin == "" {
		t.Skip("Rust text core not built (cargo build --release in services/textcore-rs)")
	}
	s := &site{products: 120, collections: 3}
	r := crawl(t, s, Job{Mode: "full", Concurrency: 8, TimeoutMs: 5000, TextCore: TextCoreConf{Bin: bin, Brand: "DeoDap"}}, nil)
	if r.done["textCore"] != true {
		t.Fatalf("text core result missing: %v", r.done["textCoreError"])
	}
	tc := r.ctx["textCore"].(map[string]any)
	if tc["ok"] != true {
		t.Fatalf("text core not ok: %v", tc)
	}
	dir := filepath.Dir(filepath.Join(os.TempDir(), "x"))
	_ = dir
	// text.json is in the work dir (crawl() uses t.TempDir; re-read via the pages list ids).
	var found bool
	for _, e := range r.events {
		if e["type"] == "progress" {
			if m, ok := e["memory"].(map[string]any); ok && m["textCoreRssMB"].(float64) > 0 {
				found = true
			}
		}
	}
	if !found && runtime.GOOS == "linux" {
		t.Error("text core memory not reported in progress")
	}
}

func TestTextCoreCrashIsReportedNotFatal(t *testing.T) {
	// A binary that exits immediately: the crawl completes, duplicate analysis is reported as unavailable.
	dir := t.TempDir()
	fake := filepath.Join(dir, "fake-textcore")
	if runtime.GOOS == "windows" {
		t.Skip("shell script fake")
	}
	os.WriteFile(fake, []byte("#!/bin/sh\necho 'SENTINEL-TEXTCORE 1'\nexit 9\n"), 0o755)
	s := &site{products: 30, collections: 2}
	r := crawl(t, s, Job{Mode: "full", Concurrency: 4, TimeoutMs: 5000, TextCore: TextCoreConf{Bin: fake}}, nil)
	if r.done["state"] != "completed" || r.done["textCore"] == true || r.done["textCoreError"] == "" {
		t.Fatalf("crash handling: %v %v %v", r.done["state"], r.done["textCore"], r.done["textCoreError"])
	}
}
