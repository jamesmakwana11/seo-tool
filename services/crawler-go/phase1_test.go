package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A burst of 429s from requests that were already in flight widens the gap once, not once per answer.
func TestThrottleCoalescesBurstsOfRateLimits(t *testing.T) {
	th := newThrottle(250*time.Millisecond, 30*time.Second)
	for i := 0; i < 8; i++ {
		th.slowDown(0)
	}
	iv, _, slow, _ := th.snapshot()
	if iv != 500*time.Millisecond || slow != 1 || th.limitedCount() != 8 {
		t.Fatalf("after one burst of 8: interval %v, slowDowns %d, limited %d (want 500ms, 1, 8)", iv, slow, th.limitedCount())
	}
	// A new burst after the window widens again (×2), and Retry-After is always honoured.
	th.mu.Lock()
	th.lastSlow = time.Now().Add(-3 * time.Second)
	th.mu.Unlock()
	th.slowDown(0)
	if iv, _, _, _ = th.snapshot(); iv != time.Second {
		t.Fatalf("second burst: %v, want 1s", iv)
	}
	th.slowDown(5 * time.Second)
	if iv, _, _, _ = th.snapshot(); iv != 5*time.Second {
		t.Fatalf("Retry-After 5s inside the window: %v", iv)
	}
	// Normal answers bring it back down.
	for i := 0; i < 40; i++ {
		th.relax()
	}
	if iv, _, _, _ = th.snapshot(); iv != 250*time.Millisecond {
		t.Fatalf("after 40 normal answers: %v, want the 250ms floor", iv)
	}
}

// Requests to other hosts (CDN images, scripts) are paced per host and never consume the site's queue.
func TestOtherHostsArePacedPerHostNotByTheSiteQueue(t *testing.T) {
	var a, b atomic.Int64
	sa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { a.Add(1); w.WriteHeader(429) }))
	defer sa.Close()
	sb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { b.Add(1); w.Write([]byte("ok")) }))
	defer sb.Close()
	siteThr := newThrottle(0, 30*time.Second)
	ext := newHTTPClient(clientOpts{Timeout: 5 * time.Second, AllowLoopback: true, PerHostDelay: 300 * time.Millisecond, Concurrency: 8})
	t0 := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		for _, u := range []string{sa.URL, sb.URL} {
			wg.Add(1)
			go func(u string) { defer wg.Done(); ext.request(context.Background(), fmt.Sprintf("%s/x%d", u, i), reqOpts{NoRetry: true}) }(u)
		}
	}
	wg.Wait()
	el := time.Since(t0)
	// 4 requests per host at 300 ms per host, both hosts in parallel: ~0.9 s (one shared queue would take ~2.1 s).
	if el > 1700*time.Millisecond {
		t.Fatalf("hosts did not run in parallel: %v", el)
	}
	if el < 800*time.Millisecond {
		t.Fatalf("per-host gap not applied: %v", el)
	}
	if iv, _, slow, _ := siteThr.snapshot(); iv != 0 || slow != 0 {
		t.Fatalf("another host's 429s touched the site's pace: %v, %d", iv, slow)
	}
	if ext.rate429.Load() != 4 || ext.done.Load() != 8 || ext.lastDone.Load() == 0 {
		t.Fatalf("counters: 429=%d done=%d", ext.rate429.Load(), ext.done.Load())
	}
}

// rateLimited allows `perSec` requests per second and answers 429 above it (a bot-protection app).
type rateLimited struct {
	mu     sync.Mutex
	window time.Time
	n      int
	perSec int
	n429   atomic.Int64
	next   http.Handler
}

func (h *rateLimited) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	now := time.Now()
	if now.Sub(h.window) >= time.Second {
		h.window, h.n = now, 0
	}
	h.n++
	over := h.n > h.perSec
	h.mu.Unlock()
	if over {
		h.n429.Add(1)
		w.WriteHeader(429)
		return
	}
	h.next.ServeHTTP(w, r)
}

func crawlServer(t *testing.T, h func(base func() string) http.Handler, job Job) (result, *httptest.Server) {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(h(func() string { return srv.URL }))
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	job.WorkDir, job.StartURL, job.BaseURL = dir, srv.URL+"/", srv.URL+"/"
	job.AllowLoopback, job.RespectRobots, job.SkipTLS = true, true, true
	job.TextCore.Disabled = true
	if job.MaxDepth == 0 {
		job.MaxDepth = -1
	}
	job.ProgressMs = 100
	var buf safeBuf
	ev := &emitter{w: bufioWriter(&buf)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c, err := newCrawler(ctx, cancel, job, ev)
	if err != nil {
		t.Fatal(err)
	}
	if code := c.run(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	return parseRun(t, dir, buf.String()), srv
}

// A site that rate-limits bursts: the crawl adapts to a gap of about a second and completes — it does not climb to
// the 30 s maximum the way per-answer doubling did with 8 requests in flight.
func TestRateLimitedSiteSettlesOnAModerateGap(t *testing.T) {
	s := &site{products: 60, collections: 2}
	var rl *rateLimited
	r, _ := crawlServer(t, func(base func() string) http.Handler {
		rl = &rateLimited{perSec: 12, next: s.handler(base)}
		return rl
	}, Job{Mode: "full", Concurrency: 8, TimeoutMs: 5000, Retries: 3, MaxRetryWaitMs: 10000})
	if r.done["state"] != "completed" {
		t.Fatalf("state %v: %v", r.done["state"], r.done["reason"])
	}
	maxDelay := 0.0
	for _, e := range r.events {
		if pol, ok := e["politeness"].(map[string]any); ok {
			if d := pol["delayMs"].(float64); d > maxDelay {
				maxDelay = d
			}
		}
	}
	if rl.n429.Load() == 0 {
		t.Fatal("the fixture never rate limited — the test proves nothing")
	}
	if maxDelay > 4000 {
		t.Fatalf("gap climbed to %.0f ms after %d 429s", maxDelay, rl.n429.Load())
	}
	pp := byPath(r.pages)
	for i := 0; i < 60; i++ {
		if p := pp[fmt.Sprintf("/products/p%d", i)]; p == nil || p["finalStatus"].(float64) != 200 {
			t.Fatalf("product %d not fetched after rate limiting: %v", i, p)
		}
	}
	counts := r.done["counts"].(map[string]any)
	pol := counts["politeness"].(map[string]any)
	if pol["rateLimited"].(float64) == 0 || pol["limitedAnswers"].(float64) < pol["slowDowns"].(float64) {
		t.Fatalf("429 accounting: %v", pol)
	}
	t.Logf("%d answers were 429, max gap %.0f ms, slow-downs %v, retries %v, %v requests", rl.n429.Load(), maxDelay, pol["slowDowns"], pol["retries"], counts["requests"])
	t.Logf("timings %v; phases %v", r.done["timings"], phaseTimes(r.events))
}

// Filter / sort links are probed as a sample after the crawl, not one request each; check progress is reported and
// every group ends done == total.
func TestFacetLinksAreSampledAndChecksReportProgress(t *testing.T) {
	var facetHits atomic.Int64
	s := &site{products: 40, collections: 2}
	r, _ := crawlServer(t, func(base func() string) http.Handler {
		inner := s.handler(base)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == "/collections/c1" && req.URL.RawQuery == "" {
				var links []string
				for i := 0; i < 120; i++ {
					links = append(links, fmt.Sprintf("/collections/c1?filter.v.price.gte=%d", i))
				}
				w.Header().Set("Content-Type", "text/html")
				w.Write([]byte(page("Collection 1", links, base()+"/collections/c1")))
				return
			}
			if strings.Contains(req.URL.RawQuery, "filter.v.price") {
				facetHits.Add(1)
			}
			inner.ServeHTTP(w, req)
		})
	}, Job{Mode: "full", Concurrency: 4, TimeoutMs: 5000})
	if r.done["state"] != "completed" {
		t.Fatalf("state %v", r.done["state"])
	}
	if facetHits.Load() > maxFacetProbes*2 { // HEAD + possible GET fallback per probe
		t.Fatalf("%d requests to filter variants (sample cap %d)", facetHits.Load(), maxFacetProbes)
	}
	counts := r.done["counts"].(map[string]any)
	checks := counts["checks"].(map[string]any)
	if checks["total"].(float64) == 0 || checks["done"] != checks["total"] {
		t.Fatalf("checks progress %v", checks)
	}
	for name, g := range checks["groups"].(map[string]any) {
		gm := g.(map[string]any)
		if gm["done"] != gm["total"] {
			t.Errorf("group %s: %v", name, gm)
		}
	}
	if counts["requests"].(float64) == 0 || counts["lastRequestAt"] == nil {
		t.Fatalf("request counters missing: %v", counts)
	}
}

// When nothing answers for longer than the gap + timeout allow, a "stalled" warning names the phase.
func TestStalledSiteRaisesAStallWarning(t *testing.T) {
	s := &site{products: 6, collections: 1}
	var srv *httptest.Server
	release := make(chan struct{})
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/products/") {
			select {
			case <-release:
			case <-time.After(4 * time.Second):
			}
		}
		s.handler(func() string { return srv.URL }).ServeHTTP(w, r)
	}))
	defer srv.Close()
	defer close(release)
	dir := t.TempDir()
	job := Job{Mode: "full", Concurrency: 2, TimeoutMs: 10000, WorkDir: dir, StartURL: srv.URL + "/", BaseURL: srv.URL + "/", AllowLoopback: true, RespectRobots: true, SkipTLS: true, MaxDepth: -1, ProgressMs: 100}
	job.TextCore.Disabled = true
	var buf safeBuf
	ev := &emitter{w: bufioWriter(&buf)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c, err := newCrawler(ctx, cancel, job, ev)
	if err != nil {
		t.Fatal(err)
	}
	c.stallMin = 1500 * time.Millisecond
	c.job.TimeoutMs = 10 // only for the stall threshold arithmetic below; requests keep their client timeout
	c.run()
	if !strings.Contains(buf.String(), `"code":"stalled"`) {
		t.Fatalf("no stall warning while every product request hung for 4 s")
	}
	if !strings.Contains(buf.String(), `phase: crawling`) {
		t.Fatalf("stall warning does not name the phase")
	}
}

func bufioWriter(w io.Writer) *bufio.Writer { return bufio.NewWriter(w) }

func parseRun(t *testing.T, dir, out string) result {
	t.Helper()
	var r result
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
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

func phaseTimes(ev []map[string]any) []string {
	var out []string
	for _, e := range ev {
		if e["type"] == "phase" {
			out = append(out, fmt.Sprintf("%v@%vms", e["phase"], e["elapsedMs"]))
		}
	}
	return out
}

// Auxiliary checks are reused: an image shown on every page is checked once, and URLs already fetched as pages are
// never probed again as link targets.
func TestAuxiliaryChecksAreReusedAcrossPages(t *testing.T) {
	var img atomic.Int64
	s := &site{products: 30, collections: 2}
	r, _ := crawlServer(t, func(base func() string) http.Handler {
		inner := s.handler(base)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == "/files/shared.jpg" {
				img.Add(1)
				w.Header().Set("Content-Type", "image/jpeg")
				w.Header().Set("Content-Length", "1234")
				return
			}
			rec := httptest.NewRecorder()
			inner.ServeHTTP(rec, req)
			for k, v := range rec.Header() {
				w.Header()[k] = v
			}
			w.WriteHeader(rec.Code)
			w.Write([]byte(strings.Replace(rec.Body.String(), "</main>", `<img src="/files/shared.jpg" alt="x"></main>`, 1)))
		})
	}, Job{Mode: "full", Concurrency: 4, TimeoutMs: 5000})
	if r.done["state"] != "completed" {
		t.Fatalf("state %v", r.done["state"])
	}
	if n := img.Load(); n < 1 || n > 2 { // HEAD (+ GET only when HEAD gives no size)
		t.Fatalf("the shared image was requested %d times for %d pages", n, len(r.pages))
	}
	fetched := map[string]int{}
	for _, p := range r.pages {
		fetched[p["url"].(string)]++
	}
	for _, lt := range r.ctx["linkTargets"].([]any) {
		u := lt.(map[string]any)["url"].(string)
		if fetched[u] > 0 {
			t.Fatalf("%s was fetched as a page and probed again as a link target", u)
		}
	}
}
