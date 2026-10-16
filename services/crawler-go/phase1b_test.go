package main

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// "Retry-After: 2" pauses the site's queue once; it does not become the gap between every later request (that is what
// held real crawls at one page per 30 s after a few 429s).
func TestRetryAfterIsAPauseNotAPermanentGap(t *testing.T) {
	s := &site{products: 30, collections: 1}
	var mu sync.Mutex
	var starts []time.Time
	var limitedAt time.Time
	var sent429 atomic.Int64
	r, _ := crawlServer(t, func(base func() string) http.Handler {
		inner := s.handler(base)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			now := time.Now()
			mu.Lock()
			starts = append(starts, now)
			mu.Unlock()
			if strings.HasPrefix(req.URL.Path, "/products/") && sent429.Load() < 1 {
				sent429.Add(1)
				mu.Lock()
				limitedAt = now
				mu.Unlock()
				w.Header().Set("Retry-After", "2")
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			inner.ServeHTTP(w, req)
		})
	}, Job{Mode: "full", Concurrency: 1, TimeoutMs: 5000, RequestDelayMs: 50, Retries: 2, MaxRetryWaitMs: 5000})
	if r.done["state"] != "completed" {
		t.Fatalf("state %v", r.done["state"])
	}
	mu.Lock()
	defer mu.Unlock()
	var after []time.Time
	for _, st := range starts {
		if st.After(limitedAt) {
			after = append(after, st)
		}
	}
	if len(after) < 20 {
		t.Fatalf("only %d requests after the 429", len(after))
	}
	if gap := after[0].Sub(limitedAt); gap < 1900*time.Millisecond {
		t.Fatalf("next request %v after the 429 — Retry-After 2 s not honoured", gap)
	}
	var maxGap time.Duration
	for i := 2; i < len(after); i++ {
		if g := after[i].Sub(after[i-1]); g > maxGap {
			maxGap = g
		}
	}
	if maxGap > 1500*time.Millisecond {
		t.Fatalf("after the pause requests were still %v apart: Retry-After became the permanent gap", maxGap)
	}
	pol := r.done["counts"].(map[string]any)["politeness"].(map[string]any)
	t.Logf("pause %v, then max gap %v over %d requests; 429s sent %d; politeness %v", after[0].Sub(limitedAt), maxGap, len(after), sent429.Load(), pol)
}

// When the post-crawl checks run out of their time budget, the remaining targets are reported as deferred — counted,
// not checked, and never written as results that the analysis could read as broken links.
func TestChecksOverTheTimeBudgetAreDeferredNotBroken(t *testing.T) {
	s := &site{products: 40, collections: 2}
	var missing atomic.Int64
	r, _ := crawlServer(t, func(base func() string) http.Handler {
		inner := s.handler(base)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if strings.HasPrefix(req.URL.Path, "/gone/") {
				missing.Add(1)
				time.Sleep(40 * time.Millisecond)
				http.NotFound(w, req)
				return
			}
			if req.URL.Path == "/" {
				var links []string
				for i := 0; i < 30; i++ {
					links = append(links, fmt.Sprintf("/gone/%d", i))
				}
				w.Header().Set("Content-Type", "text/html")
				w.Write([]byte(page("Home", links, base()+"/")))
				return
			}
			inner.ServeHTTP(w, req)
		})
	}, Job{Mode: "full", Concurrency: 2, TimeoutMs: 5000, MaxPages: 3, ChecksBudgetMs: 1})
	checks := r.done["counts"].(map[string]any)["checks"].(map[string]any)
	links := checks["groups"].(map[string]any)["links"].(map[string]any)
	done, deferred, total := links["done"].(float64), links["deferred"].(float64), links["total"].(float64)
	if total < 30 || deferred < total/2 || done+deferred != total {
		t.Fatalf("links over budget: %v", links)
	}
	lt, _ := r.ctx["linkTargets"].([]any)
	if float64(len(lt)) != done {
		t.Fatalf("%d link results written, %v checked: deferred targets must not appear as results", len(lt), done)
	}
	if st, ok := r.ctx["checkStats"].(map[string]any); !ok || st["deferred"].(float64) == 0 {
		t.Fatalf("context.json lacks the check accounting: %v", r.ctx["checkStats"])
	}
	if float64(missing.Load()) > done*2 {
		t.Fatalf("%d requests to targets, only %v checked: deferred targets were requested", missing.Load(), done)
	}
}

// Every link target is checked within the budget; the most-linked ones come first, broken ones are counted as failed.
func TestLinkChecksCountFailuresAndReuseCrawledPages(t *testing.T) {
	s := &site{products: 10, collections: 1}
	var gone atomic.Int64
	r, _ := crawlServer(t, func(base func() string) http.Handler {
		inner := s.handler(base)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if strings.HasPrefix(req.URL.Path, "/gone/") {
				gone.Add(1)
				http.NotFound(w, req)
				return
			}
			if req.URL.Path == "/" {
				w.Header().Set("Content-Type", "text/html")
				w.Write([]byte(page("Home", []string{"/gone/a", "/gone/b", "/collections/c0"}, base()+"/")))
				return
			}
			inner.ServeHTTP(w, req)
		})
	}, Job{Mode: "full", Concurrency: 2, TimeoutMs: 5000, MaxPages: 1})
	links := r.done["counts"].(map[string]any)["checks"].(map[string]any)["groups"].(map[string]any)["links"].(map[string]any)
	if links["failed"].(float64) < 2 || links["done"].(float64)+links["deferred"].(float64) != links["total"].(float64) || links["reused"].(float64) == 0 {
		t.Fatalf("link accounting: %v", links)
	}
	if n := gone.Load(); n > 4 { // each broken target: one HEAD (+ one GET only after a HEAD transport failure)
		t.Fatalf("broken targets requested %d times", n)
	}
}

// An image check answered 429 slows the site down like any page request, is not repeated with a GET, and is
// reported as deferred (not checked) — never as a failed or heavy image.
func TestRateLimitedImageChecksAreDeferredAndSlowTheSite(t *testing.T) {
	s := &site{products: 12, collections: 1}
	var heads, gets atomic.Int64
	r, _ := crawlServer(t, func(base func() string) http.Handler {
		inner := s.handler(base)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if strings.HasPrefix(req.URL.Path, "/files/") {
				if req.Method == http.MethodHead {
					heads.Add(1)
				} else {
					gets.Add(1)
				}
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			if strings.HasPrefix(req.URL.Path, "/products/") {
				w.Header().Set("Content-Type", "text/html")
				w.Write([]byte(strings.Replace(page("P", nil, base()+req.URL.Path), "</main>", `<img src="/files/`+strings.TrimPrefix(req.URL.Path, "/products/")+`.jpg" alt="x"></main>`, 1)))
				return
			}
			inner.ServeHTTP(w, req)
		})
	}, Job{Mode: "full", Concurrency: 2, TimeoutMs: 5000, Retries: 0, ChecksBudgetMs: 60000})
	g := r.done["counts"].(map[string]any)["checks"].(map[string]any)["groups"].(map[string]any)["images"].(map[string]any)
	if g["total"].(float64) == 0 || g["deferred"].(float64) != g["total"].(float64) || g["failed"].(float64) != 0 {
		t.Fatalf("rate-limited images: %v", g)
	}
	if imgs, _ := r.ctx["images"].([]any); len(imgs) != 0 {
		t.Fatalf("%d rate-limited images written as results", len(imgs))
	}
	if gets.Load() != 0 {
		t.Fatalf("%d GET requests after HEAD answered 429", gets.Load())
	}
	pol := r.done["counts"].(map[string]any)["politeness"].(map[string]any)
	if pol["limitedAnswers"].(float64) < float64(heads.Load()) || pol["slowDowns"].(float64) == 0 {
		t.Fatalf("image 429s did not slow the site: %v (heads %d)", pol, heads.Load())
	}
}
