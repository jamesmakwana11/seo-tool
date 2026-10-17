package main

import (
	"container/heap"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ------------------------------------------------------------------------------------------------ URL states

// Discovery sources (bit set).
const (
	srcStart uint8 = 1 << iota
	srcLink
	srcSitemap
	srcPagination
	srcRedirect
	srcSeed
)

var srcNames = []struct {
	bit  uint8
	name string
}{{srcStart, "start"}, {srcLink, "link"}, {srcSitemap, "sitemap"}, {srcPagination, "pagination"}, {srcRedirect, "redirect"}, {srcSeed, "seed"}}

func sourceList(b uint8) []string {
	out := []string{}
	for _, s := range srcNames {
		if b&s.bit != 0 {
			out = append(out, s.name)
		}
	}
	return out
}

// Coverage states of a discovered URL.
const (
	stQueued       uint8 = iota + 1 // eligible, waiting for a worker
	stActive                        // being fetched
	stFetched                       // fetched (any outcome)
	stExcluded                      // out of scope by rule (see reason)
	stRobots                        // disallowed by robots.txt
	stDepth                         // beyond the depth limit
	stLimit                         // eligible, not fetched: the page limit was reached
	stNotProcessed                  // eligible, not fetched: cancelled / resource limit
	stWaiting                       // sitemap-only URL waiting for link discovery to finish
)

var stateNames = map[uint8]string{stQueued: "queued", stActive: "active", stFetched: "fetched", stExcluded: "excluded", stRobots: "robots", stDepth: "depth_limit", stLimit: "page_limit", stNotProcessed: "not_processed", stWaiting: "waiting"}

// Exclusion reasons.
const (
	rNone uint8 = iota
	rNonHTML
	rSkipPath
	rFacet
	rParamCap
	rTrap
	rUser
	rScoped
)

var reasonNames = map[uint8]string{rNonHTML: "non_html", rSkipPath: "cart_account_or_app_path", rFacet: "sort_filter_search_parameter", rParamCap: "too_many_parameter_variants", rTrap: "crawl_trap", rUser: "excluded_by_settings", rScoped: "collection_scoped_product_path"}

type uState struct {
	id       int32
	url      string
	depth    int32
	src      uint8
	state    uint8
	reason   uint8
	from     int32
	inlinks  int32
	prio     float32
	seedPrio float32
	seedWhy  string
	lastmod  string
	trap     string
	robots   string
}

// ------------------------------------------------------------------------------------------------ queues

type queue interface {
	push(st *uState)
	pop() (*uState, bool)
	size() int
}

// bucketQueue: FIFO per depth, lowest depth first; URLs without a click depth (sitemap-only) last.
type bucketQueue struct {
	buckets map[int32][]*uState
	heads   map[int32]int
	depths  []int32
	n       int
}

func newBucketQueue() *bucketQueue {
	return &bucketQueue{buckets: map[int32][]*uState{}, heads: map[int32]int{}}
}

func (q *bucketQueue) key(d int32) int32 {
	if d < 0 {
		return 1 << 30
	}
	return d
}

func (q *bucketQueue) push(st *uState) {
	k := q.key(st.depth)
	if _, ok := q.buckets[k]; !ok {
		q.depths = append(q.depths, k)
		sort.Slice(q.depths, func(i, j int) bool { return q.depths[i] < q.depths[j] })
	}
	q.buckets[k] = append(q.buckets[k], st)
	q.n++
}

func (q *bucketQueue) pop() (*uState, bool) {
	for len(q.depths) > 0 {
		k := q.depths[0]
		b := q.buckets[k]
		h := q.heads[k]
		if h < len(b) {
			st := b[h]
			b[h] = nil
			q.heads[k] = h + 1
			q.n--
			if h+1 == len(b) {
				delete(q.buckets, k)
				delete(q.heads, k)
				q.depths = q.depths[1:]
			}
			return st, true
		}
		delete(q.buckets, k)
		delete(q.heads, k)
		q.depths = q.depths[1:]
	}
	return nil, false
}

func (q *bucketQueue) size() int { return q.n }

// prioQueue: highest priority first (Smart crawl). Entries are re-pushed when a URL's priority rises; stale
// entries are skipped on pop.
type prioItem struct {
	st   *uState
	prio float32
	seq  int64
}
type prioHeap []prioItem

func (h prioHeap) Len() int { return len(h) }
func (h prioHeap) Less(i, j int) bool {
	if h[i].prio != h[j].prio {
		return h[i].prio > h[j].prio
	}
	return h[i].seq < h[j].seq
}
func (h prioHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *prioHeap) Push(x any)   { *h = append(*h, x.(prioItem)) }
func (h *prioHeap) Pop() any {
	old := *h
	it := old[len(old)-1]
	*h = old[:len(old)-1]
	return it
}

type prioQueue struct {
	h    prioHeap
	seq  int64
	live map[int32]bool
}

func newPrioQueue() *prioQueue { return &prioQueue{live: map[int32]bool{}} }
func (q *prioQueue) push(st *uState) {
	q.seq++
	heap.Push(&q.h, prioItem{st: st, prio: st.prio, seq: q.seq})
	q.live[st.id] = true
}
func (q *prioQueue) pop() (*uState, bool) {
	for q.h.Len() > 0 {
		it := heap.Pop(&q.h).(prioItem)
		if it.st.state != stQueued || it.prio != it.st.prio || !q.live[it.st.id] {
			continue
		}
		delete(q.live, it.st.id)
		return it.st, true
	}
	return nil, false
}
func (q *prioQueue) size() int { return len(q.live) }

// ------------------------------------------------------------------------------------------------ records

type PageRecord struct {
	FetchResult
	ID              int32       `json:"id"`
	Template        string      `json:"template"`
	Reason          string      `json:"reason"`
	Depth           *int        `json:"depth,omitempty"`
	InSitemap       bool        `json:"inSitemap"`
	SkippedByRobots bool        `json:"skippedByRobots,omitempty"`
	DerivedFrom     string      `json:"derivedFrom,omitempty"`
	BudgetSample    string      `json:"budgetSample,omitempty"`
	ScopedSample    bool        `json:"scopedSample,omitempty"`
	Paginated       bool        `json:"paginated,omitempty"`
	FoundVia        []string    `json:"foundVia,omitempty"`
	FoundOn         string      `json:"foundOn,omitempty"`
	HTML            *ParsedHTML `json:"html,omitempty"`
}

type LinkStatus struct {
	URL          string        `json:"url"`
	Status       *int          `json:"status"`
	FinalStatus  *int          `json:"finalStatus"`
	FinalURL     string        `json:"finalUrl"`
	Chain        []RedirectHop `json:"chain"`
	RedirectLoop bool          `json:"redirectLoop"`
	Error        string        `json:"error,omitempty"`
}

type AssetInfo struct {
	URL         string `json:"url"`
	Status      *int   `json:"status"`
	Bytes       *int   `json:"bytes,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	Error       string `json:"error,omitempty"`
}

type TLSInfo struct {
	Host               string `json:"host"`
	ValidTo            string `json:"validTo,omitempty"`
	DaysLeft           *int   `json:"daysLeft,omitempty"`
	Authorized         *bool  `json:"authorized,omitempty"`
	AuthorizationError string `json:"authorizationError,omitempty"`
	Error              string `json:"error,omitempty"`
}

type HostVariant struct {
	URL         string        `json:"url"`
	IsCanonical bool          `json:"isCanonical"`
	Status      *int          `json:"status"`
	FinalStatus *int          `json:"finalStatus"`
	FinalURL    string        `json:"finalUrl"`
	Chain       []RedirectHop `json:"chain"`
	Error       string        `json:"error,omitempty"`
}

type URLRecord struct {
	URL       string   `json:"url"`
	State     string   `json:"state"`
	Reason    string   `json:"reason,omitempty"`
	Depth     *int     `json:"depth,omitempty"`
	FoundVia  []string `json:"foundVia"`
	FoundOn   string   `json:"foundOn,omitempty"`
	Template  string   `json:"template"`
	Inlinks   int32    `json:"inlinks"`
	Priority  float32  `json:"priority,omitempty"`
	Robots    string   `json:"robots,omitempty"`
	Trap      string   `json:"trap,omitempty"`
	Lastmod   string   `json:"lastmod,omitempty"`
	InSitemap bool     `json:"inSitemap"`
}

// ------------------------------------------------------------------------------------------------ crawler

type reqSample struct {
	t time.Time
	n int64
}

// checkGroup counts one group of post-crawl checks (link targets, images, scripts …): total = targets found,
// done = checked (failed ⊂ done), deferred = not checked because of a cap or the time budget (never reported as
// broken); a group is finished when done + deferred = total. excluded = left out on purpose (robots.txt, your
// exclusions, filter / sort variants beyond the sample) and reused = already answered by the page crawl — neither
// is in total.
type checkGroup struct {
	total, done, failed, deferred, excluded, reused atomic.Int64
	atLeast                                         atomic.Bool // deferred was counted up to a bound: "at least"
}

// skip counts a target that is not checked because of a cap.
func (g *checkGroup) skip() { g.total.Add(1); g.deferred.Add(1) }

func (c *Crawler) group(name string, total int) *checkGroup {
	c.checkMu.Lock()
	defer c.checkMu.Unlock()
	if c.checkGroups == nil {
		c.checkGroups = map[string]*checkGroup{}
	}
	g := c.checkGroups[name]
	if g == nil {
		g = &checkGroup{}
		c.checkGroups[name] = g
		c.checkOrder = append(c.checkOrder, name)
	}
	g.total.Add(int64(total))
	return g
}

func (c *Crawler) checkProgress() map[string]any {
	c.checkMu.Lock()
	defer c.checkMu.Unlock()
	groups := map[string]any{}
	var total, done, deferred int64
	for _, n := range c.checkOrder {
		g := c.checkGroups[n]
		t, d := g.total.Load(), g.done.Load()
		total += t
		done += d
		deferred += g.deferred.Load()
		gm := map[string]any{"total": t, "done": d, "failed": g.failed.Load(), "deferred": g.deferred.Load(), "excluded": g.excluded.Load(), "reused": g.reused.Load()}
		if g.atLeast.Load() {
			gm["deferredAtLeast"] = true
		}
		groups[n] = gm
	}
	return map[string]any{"total": total, "done": done, "deferred": deferred, "groups": groups}
}

// Outcome of one post-crawl check.
const (
	checkOK = iota
	checkFailed
	// checkDeferred: the site was still rate limiting (429 / 503 after the retries) — the target was not really
	// checked, so it is reported as deferred and never written as a broken link or image.
	checkDeferred
)

// outcomeOf classifies a final status: 429 / 503 → deferred, no answer or ≥ 400 → failed.
func outcomeOf(st *int) int {
	switch {
	case st != nil && (*st == 429 || *st == 503):
		return checkDeferred
	case st == nil || *st >= 400:
		return checkFailed
	}
	return checkOK
}

// gcheck runs fn over items with n workers inside the check time budget. Items reached after the budget (or a stop),
// and items the site would not answer because it was rate limiting, are counted as deferred and left out of the
// results — the analysis then treats them as "not checked", not broken.
func gcheck[T any, R any](c *Crawler, g *checkGroup, items []T, n int, fn func(T) (R, int)) []R {
	type res struct {
		r  R
		ok bool
	}
	out := pool(items, n, func(it T) res {
		if c.stopped() || c.pastCheckBudget() {
			g.deferred.Add(1)
			return res{}
		}
		r, oc := fn(it)
		switch oc {
		case checkDeferred:
			g.deferred.Add(1)
			return res{}
		case checkFailed:
			g.failed.Add(1)
		}
		g.done.Add(1)
		return res{r, true}
	})
	kept := make([]R, 0, len(out))
	for _, x := range out {
		if x.ok {
			kept = append(kept, x.r)
		}
	}
	return kept
}

func (c *Crawler) pastCheckBudget() bool {
	c.checkMu.Lock()
	d := c.checkDeadline
	c.checkMu.Unlock()
	return !d.IsZero() && time.Now().After(d)
}

// gpool runs fn over items with n workers and counts each finished item in g.
func gpool[T any, R any](g *checkGroup, items []T, n int, fn func(T) R) []R {
	return pool(items, n, func(it T) R {
		r := fn(it)
		g.done.Add(1)
		return r
	})
}

type Crawler struct {
	job      Job
	ctx      context.Context
	cancel   context.CancelFunc
	ev       *emitter
	thr      *throttle
	site     *httpClient
	ext      *httpClient
	siteHost string
	origin   string
	homepage string
	start    string
	resolved string

	robots     *robots
	robotsInfo map[string]any
	crawlDelay time.Duration

	mu        sync.Mutex
	cond      *sync.Cond
	urls      map[string]*uState
	byID      []*uState
	q         queue
	active    int
	started   int // page fetches started (the page limit counts these)
	capHit    bool
	stopWhy   atomic.Value // "", user, resource, parent_gone, memory
	paramCap  map[string]int
	counts    map[uint8]int
	excluded  map[uint8]int
	processed int
	succeeded int
	failed    int
	discovery bool // link discovery phase still running (sitemap-only URLs wait)
	noFollow  bool // fetch queued pages but do not follow their links (sitemap-only pages under a depth limit)

	pages    *gzWriter
	urlsW    *gzWriter
	sitemapW *gzWriter
	text     *textCore
	textErr  string

	// bounded context candidates
	ctxMu         sync.Mutex
	canonTargets  map[string]bool
	canonOrder    []string
	images        []string
	imageSeen     map[string]bool
	externals     []string
	externalSeen  map[string]bool
	scripts       []string
	scriptSeen    map[string]bool
	budgetURLs    []string
	budgetCount   int
	slashSample   string
	scopedLinks   []string
	scopedSeen    map[string]bool
	paginationCan []string
	pagSeen       map[string]bool

	sitemapRes  sitemapResult
	sitemapDone chan struct{}
	sitemapURLs int

	checkMu       sync.Mutex
	checkOrder    []string
	checkGroups   map[string]*checkGroup // post-crawl checks: total / done per group (progress)
	checkDeadline time.Time              // post-crawl checks stop starting new requests after this
	imageCount    map[string]int         // pages each collected image appears on (checked most-used first)
	imagesOver    map[string]bool        // distinct images beyond the image cap (reported as deferred; bounded)
	outMu         sync.Mutex

	reqSamples  []reqSample // (time, requests answered) every progress tick: requests per minute
	completions []time.Time // recent fetch completions (pages per minute)
	lastDone    time.Time
	activeSince map[int32]time.Time
	stallWarned time.Time
	stallMin    time.Duration // minimum silence before a stall warning (90 s; tests lower it)
	phase       string
	t0          time.Time
	timings     map[string]int
	memPeakMB   float64
	textPeakMB  float64
}

var firstPartyCDN = regexp.MustCompile(`(?i)(^|\.)cdn\.shopify\.com$|(^|\.)shopifycdn\.(com|net)$|(^|\.)shopify\.com$|(^|\.)myshopify\.com$`)
var imageCDN = regexp.MustCompile(`(?i)(^|\.)cdn\.shopify\.com$|(^|\.)shopifycdn\.(com|net)$|^cdn\.|imgix\.net$|cloudinary\.com$|cloudfront\.net$`)

func newCrawler(ctx context.Context, cancel context.CancelFunc, job Job, ev *emitter) (*Crawler, error) {
	if err := job.normalize(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(job.WorkDir, 0o700); err != nil {
		return nil, fmt.Errorf("cannot create work directory: %v", err)
	}
	c := &Crawler{job: job, ctx: ctx, cancel: cancel, ev: ev, urls: map[string]*uState{}, paramCap: map[string]int{}, counts: map[uint8]int{}, excluded: map[uint8]int{},
		canonTargets: map[string]bool{}, imageSeen: map[string]bool{}, imageCount: map[string]int{}, imagesOver: map[string]bool{}, externalSeen: map[string]bool{}, scriptSeen: map[string]bool{}, scopedSeen: map[string]bool{}, pagSeen: map[string]bool{},
		sitemapDone: make(chan struct{}), activeSince: map[int32]time.Time{}, timings: map[string]int{}, t0: time.Now()}
	c.cond = sync.NewCond(&c.mu)
	c.stopWhy.Store("")
	maxThrottle := time.Duration(job.MaxCrawlDelayMs) * time.Millisecond
	if maxThrottle < 30*time.Second {
		maxThrottle = 30 * time.Second
	}
	c.thr = newThrottle(time.Duration(job.RequestDelayMs)*time.Millisecond, maxThrottle)
	base := clientOpts{UserAgent: job.UserAgent, Timeout: time.Duration(job.TimeoutMs) * time.Millisecond, MaxBody: job.MaxBodyBytes, Retries: job.Retries,
		MaxRetryWait: time.Duration(job.MaxRetryWaitMs) * time.Millisecond, AllowLoopback: job.AllowLoopback, Concurrency: job.Concurrency}
	site := base
	site.Throttle = c.thr
	c.site = newHTTPClient(site)
	ext := base
	ext.Retries = 0
	ext.PerHostDelay = 150 * time.Millisecond // CDN images, scripts, external links: polite per host, never the site's queue
	c.ext = newHTTPClient(ext)
	if job.Mode == "smart" {
		c.q = newPrioQueue()
	} else {
		c.q = newBucketQueue()
	}
	if job.MemoryLimitMB > 0 {
		debug.SetMemoryLimit(int64(job.MemoryLimitMB) << 20)
	}
	return c, nil
}

func (c *Crawler) stop(reason string) {
	if c.stopWhy.Load().(string) == "" {
		c.stopWhy.Store(reason)
	}
	c.cancel()
	c.mu.Lock()
	c.cond.Broadcast()
	c.mu.Unlock()
}

func (c *Crawler) stopped() bool { return c.stopWhy.Load().(string) != "" }

func (c *Crawler) setPhase(p string) {
	c.phase = p
	c.ev.emit(map[string]any{"type": "phase", "phase": p, "elapsedMs": time.Since(c.t0).Milliseconds()})
}

// setState moves a URL to a new coverage state, keeping the counters exact. Caller holds c.mu.
func (c *Crawler) setState(st *uState, s uint8, reason uint8) {
	if st.state != 0 {
		c.counts[st.state]--
		if st.state == stExcluded {
			c.excluded[st.reason]--
		}
	}
	st.state = s
	st.reason = reason
	c.counts[s]++
	if s == stExcluded {
		c.excluded[reason]++
	}
}

func templatePriority(t string) float32 {
	switch t {
	case "home":
		return 1000
	case "collection":
		return 300
	case "product":
		return 120
	case "page":
		return 80
	case "blog_article":
		return 60
	case "blog_index":
		return 50
	case "search":
		return 0
	}
	return 30
}

func (c *Crawler) priority(st *uState) float32 {
	p := templatePriority(templateOf(st.url)) + st.seedPrio
	in := st.inlinks
	if in > 50 {
		in = 50
	}
	p += float32(in) * 10
	if st.lastmod != "" {
		if t, err := time.Parse(time.RFC3339, st.lastmod); err == nil && time.Since(t) < 48*time.Hour {
			p += 150
		} else if t, err := time.Parse("2006-01-02", st.lastmod); err == nil && time.Since(t) < 72*time.Hour {
			p += 150
		}
	}
	if st.depth > 0 {
		p -= float32(st.depth) * 20
	}
	return p
}

// discover registers a URL found at `depth` via `src` (caller holds c.mu). Returns true when newly queued.
func (c *Crawler) discover(raw string, src uint8, depth int32, from int32) bool {
	if !isSameSite(raw, c.siteHost) {
		return false
	}
	key := normalizeKey(raw)
	if st, ok := c.urls[key]; ok {
		st.src |= src
		if src&(srcLink|srcPagination) != 0 {
			st.inlinks++
		}
		if depth >= 0 && (st.depth < 0 || depth < st.depth) && (st.state == stQueued || st.state == stWaiting || st.state == stDepth) {
			st.depth = depth
			if st.state == stDepth && (c.job.MaxDepth < 0 || depth <= int32(c.job.MaxDepth)) {
				c.setState(st, stQueued, rNone)
				c.q.push(st)
				return true
			}
		}
		if st.state == stWaiting && src&(srcLink|srcPagination|srcStart|srcSeed) != 0 {
			c.setState(st, stQueued, rNone)
			if c.job.Mode == "smart" {
				st.prio = c.priority(st)
			}
			c.q.push(st)
			return true
		}
		if c.job.Mode == "smart" && st.state == stQueued {
			if np := c.priority(st); np >= st.prio+10 {
				st.prio = np
				c.q.push(st)
			}
		}
		return false
	}
	st := &uState{id: int32(len(c.byID)), url: key, depth: depth, src: src, from: from}
	if src&(srcLink|srcPagination) != 0 {
		st.inlinks = 1
	}
	c.urls[key] = st
	c.byID = append(c.byID, st)
	path := pathOf(key)
	qc, _ := queryClass(key)
	switch {
	case nonHTMLExt.MatchString(path):
		c.setState(st, stExcluded, rNonHTML)
		return false
	case skipPaths.MatchString(path):
		c.setState(st, stExcluded, rSkipPath)
		return false
	}
	if t := crawlTrapReason(key); t != "" {
		st.trap = t
		c.setState(st, stExcluded, rTrap)
		return false
	}
	for _, pat := range c.job.ExcludePatterns {
		if globMatch(pat, path) {
			c.setState(st, stExcluded, rUser)
			return false
		}
	}
	// Shopify's /collections/{c}/products/{p} is the same product page under another path (its canonical is
	// /products/{p}). Following every one of them fetches each product once per collection it is in, so it is not
	// crawled as a page: the canonical product URL is discovered instead, and a few scoped URLs are fetched after the
	// crawl as samples to verify that their canonical really points to /products/{p} (TECH-SHOPIFY-DUP-PATHS).
	if src&(srcStart|srcSeed) == 0 && scopedRe.MatchString(path) {
		if h := productHandle(key); h != "" {
			c.setState(st, stExcluded, rScoped)
			return c.discover(c.origin+"/products/"+h, (src&(srcLink|srcSitemap|srcRedirect))|srcLink, depth, from)
		}
	}
	if src&srcSitemap == 0 {
		if br := budgetReason(key); br != "" && qc != qPagination {
			c.noteBudget(key)
		}
	}
	switch qc {
	case qFacet:
		c.setState(st, stExcluded, rFacet)
		return false
	case qOther:
		c.paramCap[path]++
		if c.paramCap[path] > 25 {
			c.setState(st, stExcluded, rParamCap)
			return false
		}
	case qPagination:
		st.src |= srcPagination
	}
	if c.robots != nil && c.job.RespectRobots {
		u, _ := url.Parse(key)
		pq := u.EscapedPath()
		if u.RawQuery != "" {
			pq += "?" + u.RawQuery
		}
		if ok, rule := c.robots.allowed(c.job.UserAgent, pq); !ok {
			msg := "skipped: disallowed by robots.txt for our user-agent"
			if rule != nil {
				msg += fmt.Sprintf(" (line %d: Disallow: %s)", rule.Line, rule.Path)
			}
			st.robots = msg
			c.setState(st, stRobots, rNone)
			c.writeRobotsRecord(st)
			return false
		}
	}
	if c.job.MaxDepth >= 0 && depth > int32(c.job.MaxDepth) {
		c.setState(st, stDepth, rNone)
		return false
	}
	if src&(srcLink|srcPagination|srcStart|srcSeed|srcRedirect) == 0 && c.discovery && c.job.Mode == "full" {
		c.setState(st, stWaiting, rNone)
		return false
	}
	c.setState(st, stQueued, rNone)
	if c.job.Mode == "smart" {
		st.prio = c.priority(st)
	}
	c.q.push(st)
	return true
}

func (c *Crawler) noteBudget(u string) {
	c.ctxMu.Lock()
	c.budgetCount++
	if len(c.budgetURLs) < 20000 {
		c.budgetURLs = append(c.budgetURLs, u)
	}
	c.ctxMu.Unlock()
}

func (c *Crawler) writeRobotsRecord(st *uState) {
	rec := PageRecord{FetchResult: FetchResult{URL: st.url, FinalURL: st.url, Chain: []RedirectHop{}, Headers: map[string]string{}, Error: st.robots},
		ID: st.id, Template: templateOf(st.url), Reason: c.reasonFor(st), SkippedByRobots: true, FoundVia: sourceList(st.src), FoundOn: c.urlOf(st.from)}
	if st.depth >= 0 {
		rec.Depth = intp(int(st.depth))
	}
	c.pages.write(rec)
}

func (c *Crawler) urlOf(id int32) string {
	if id < 0 || int(id) >= len(c.byID) {
		return ""
	}
	return c.byID[id].url
}

func (c *Crawler) reasonFor(st *uState) string {
	if st.seedWhy != "" {
		return st.seedWhy
	}
	if st.src&srcStart != 0 {
		if strings.TrimRight(st.url, "/") == strings.TrimRight(c.homepage, "/") {
			return "homepage"
		}
		return "full"
	}
	if st.src&(srcLink|srcPagination|srcRedirect) == 0 && st.src&srcSitemap != 0 {
		return "sitemap"
	}
	// Linked only beyond the depth limit: it is crawled because the sitemap lists it.
	if c.job.MaxDepth >= 0 && st.depth > int32(c.job.MaxDepth) && st.src&srcSitemap != 0 {
		return "sitemap"
	}
	return "full"
}

// next hands a queued URL to a worker; false when there is nothing left (or the crawl stops / hits the page limit).
func (c *Crawler) next() (*uState, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for {
		if c.stopped() {
			return nil, false
		}
		if c.job.MaxPages > 0 && c.started >= c.job.MaxPages {
			if c.q.size() > 0 {
				c.capHit = true
			}
			c.cond.Broadcast()
			return nil, false
		}
		if st, ok := c.q.pop(); ok {
			if st.state != stQueued {
				continue
			}
			c.setState(st, stActive, rNone)
			c.active++
			c.started++
			c.activeSince[st.id] = time.Now()
			return st, true
		}
		if c.active == 0 {
			c.cond.Broadcast()
			return nil, false
		}
		c.cond.Wait()
	}
}

func (c *Crawler) runWorkers(n int) {
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				st, ok := c.next()
				if !ok {
					return
				}
				c.process(st, "", false)
				c.mu.Lock()
				c.active--
				delete(c.activeSince, st.id)
				c.cond.Broadcast()
				c.mu.Unlock()
			}
		}()
	}
	wg.Wait()
}

func isHTMLType(ct string) bool { return ct == "" || strings.Contains(strings.ToLower(ct), "html") }

var keptHeaders = []string{"x-robots-tag", "strict-transport-security", "content-type", "content-language", "link", "last-modified"}

func trimHeaders(h map[string]string, all bool) map[string]string {
	if all {
		return h
	}
	out := map[string]string{}
	for _, k := range keptHeaders {
		if v, ok := h[k]; ok {
			out[k] = v
		}
	}
	return out
}

var scopedRe = regexp.MustCompile(`^/collections/[^/]+/products/`)

// process fetches one URL, writes its record(s), feeds the text core and discovers links. `sample` marks pages
// fetched as crawl-budget samples (not followed).
// process fetches one URL. samplePhase: fetched as a check sample after the crawl (its link depth is not a crawl depth).
func (c *Crawler) process(st *uState, sample string, samplePhase bool) {
	res := c.site.request(c.ctx, st.url, reqOpts{ReadBody: true})
	if res.Error == "cancelled" && c.ctx.Err() != nil {
		c.mu.Lock()
		c.setState(st, stNotProcessed, rNone)
		c.mu.Unlock()
		return
	}
	tpl := templateOf(st.url)
	home := tpl == "home" || templateOf(res.FinalURL) == "home"
	res.Headers = trimHeaders(res.Headers, home)
	rec := PageRecord{FetchResult: res, ID: st.id, Template: tpl, Reason: c.reasonFor(st), FoundVia: sourceList(st.src), FoundOn: c.urlOf(st.from)}
	if sample != "" {
		rec.BudgetSample = sample
	}
	if st.depth >= 0 && !samplePhase {
		rec.Depth = intp(int(st.depth))
	}
	markSample(&rec)
	if scopedRe.MatchString(pathOf(st.url)) {
		rec.ScopedSample = true
	}
	var parsed *ParsedHTML
	fs := res.FinalStatus
	if fs != nil && *fs == 200 && res.Body != nil && isHTMLType(res.ContentType) {
		parsed = extractHTML(res.Body, res.FinalURL, c.siteHost)
	}
	rec.Body = nil
	var derived *PageRecord
	var derivedState *uState
	if parsed != nil {
		if len(res.Chain) == 0 {
			rec.HTML = parsed
		} else if isSameSite(res.FinalURL, c.siteHost) {
			// The redirect target is recorded as its own page unless it was already fetched.
			c.mu.Lock()
			key := normalizeKey(res.FinalURL)
			ds, known := c.urls[key]
			if !known || (ds.state != stFetched && ds.state != stActive) {
				if !known {
					c.discover(res.FinalURL, srcRedirect, st.depth, st.id)
					ds = c.urls[key]
				}
				if ds != nil && ds.state != stFetched && ds.state != stActive {
					if ds.state == stQueued || ds.state == stWaiting || ds.state == stDepth || ds.state == stExcluded || ds.state == stRobots {
						c.setState(ds, stFetched, rNone)
					}
					derivedState = ds
				}
			}
			c.mu.Unlock()
			if derivedState != nil {
				dfs := *res.FinalStatus
				d := PageRecord{FetchResult: FetchResult{URL: res.FinalURL, FinalURL: res.FinalURL, Status: intp(dfs), FinalStatus: intp(dfs), Chain: []RedirectHop{},
					ResponseMs: res.FinalResponseMs, TotalMs: res.TotalMs, Headers: res.Headers, ContentType: res.ContentType, Bytes: res.Bytes, Truncated: res.Truncated},
					ID: derivedState.id, Template: templateOf(res.FinalURL), Reason: rec.Reason, DerivedFrom: st.url, HTML: parsed, Depth: rec.Depth, FoundVia: []string{"redirect"}, FoundOn: st.url}
				markSample(&d)
				derived = &d
			}
		}
	}
	// Counters (a page "succeeds" when its final answer is below 400).
	c.mu.Lock()
	c.setState(st, stFetched, rNone)
	c.processed++
	ok := res.FinalStatus != nil && *res.FinalStatus < 400 && res.Status != nil
	if ok {
		c.succeeded++
	} else {
		c.failed++
	}
	now := time.Now()
	c.lastDone = now
	c.completions = append(c.completions, now)
	if len(c.completions) > 4096 {
		c.completions = c.completions[len(c.completions)-2048:]
	}
	c.mu.Unlock()

	c.pages.write(rec)
	if derived != nil {
		c.pages.write(derived)
	}
	if parsed != nil {
		src := &rec
		if derived != nil {
			src = derived
		}
		c.sendText(src)
		if sample == "" && !c.noFollow {
			c.discoverFrom(st, parsed)
		}
		c.collectContext(src, parsed)
	}
}

// markSample: ?page=N (N ≥ 2) pages are pagination; parameter / tag URLs are crawl-budget samples (as in the Node API).
func markSample(r *PageRecord) {
	if _, ok := paginationPage(r.URL); ok {
		r.Paginated = true
		return
	}
	if r.BudgetSample == "" {
		if br := budgetReason(r.URL); br != "" {
			r.BudgetSample = br
		}
	}
}

func (c *Crawler) sendText(r *PageRecord) {
	if c.text == nil || r.HTML == nil {
		return
	}
	h := r.HTML
	okPage := !r.SkippedByRobots && r.BudgetSample == "" && !r.Paginated && !r.ScopedSample && r.Status != nil && *r.Status == 200 && len(r.Chain) == 0
	tp := textPage{id: r.ID, template: r.Template, ok: okPage, blocks: h.OwnBlocks}
	if h.Title != nil {
		tp.title = *h.Title
	}
	if h.MetaDescription != nil {
		tp.meta = *h.MetaDescription
	}
	if len(h.H1s) > 0 {
		tp.h1 = h.H1s[0]
		if len(h.H1s) > 1 {
			tp.h1 = h.H1s[0] + "\x00multi"
		}
	}
	if h.DescriptionText != nil {
		tp.desc = *h.DescriptionText
	}
	c.text.send(tp)
}

func (c *Crawler) discoverFrom(st *uState, h *ParsedHTML) {
	depth := int32(-1)
	if st.depth >= 0 {
		depth = st.depth + 1
	}
	links := h.InternalLinks
	if h.Pagination.Next != nil {
		links = append(append([]string{}, links...), *h.Pagination.Next)
	}
	c.mu.Lock()
	added := false
	for _, l := range links {
		src := srcLink
		if _, ok := paginationPage(l); ok {
			src |= srcPagination
		}
		if c.discover(l, src, depth, st.id) {
			added = true
		}
	}
	if added {
		c.cond.Broadcast()
	}
	c.mu.Unlock()
}

func (c *Crawler) collectContext(r *PageRecord, h *ParsedHTML) {
	l := c.job.Limits
	c.ctxMu.Lock()
	defer c.ctxMu.Unlock()
	for _, cn := range h.Canonicals {
		if cn != "" && isSameSite(cn, c.siteHost) && !c.canonTargets[cn] && len(c.canonOrder) < 5000 {
			c.canonTargets[cn] = true
			c.canonOrder = append(c.canonOrder, cn)
		}
	}
	if c.job.needs("images") {
		// ALT text, dimensions and lazy-loading come from the HTML itself; only the weight / format of an image needs a
		// request, and each distinct image file is requested once however many pages show it.
		n := 0
		for _, im := range h.Images {
			if !im.InMain {
				continue
			}
			src := strings.SplitN(im.Src, "#", 2)[0]
			if c.imageSeen[src] {
				c.imageCount[src]++
				continue
			}
			if !(isSameSite(src, c.siteHost) || imageCDN.MatchString(hostOf(src))) {
				continue
			}
			if n >= l.ImagesPerPage || len(c.images) >= l.ImagesTotal {
				if len(c.imagesOver) < 20000 {
					c.imagesOver[src] = true
				}
				continue
			}
			n++
			c.imageSeen[src] = true
			c.imageCount[src] = 1
			c.images = append(c.images, src)
		}
	}
	if c.job.needs("external") {
		for _, e := range h.ExternalLinks {
			if len(c.externals) >= l.ExternalLinks {
				break
			}
			if c.externalSeen[e] || firstPartyCDN.MatchString(hostOf(e)) {
				continue
			}
			c.externalSeen[e] = true
			c.externals = append(c.externals, e)
		}
	}
	if c.job.needs("scripts") {
		for _, s := range h.ScriptSrcs {
			if len(c.scripts) >= l.ThirdPartyScripts {
				break
			}
			if c.scriptSeen[s] || isSameSite(s, c.siteHost) {
				continue
			}
			c.scriptSeen[s] = true
			c.scripts = append(c.scripts, s)
		}
	}
	if c.slashSample == "" && r.Status != nil && *r.Status == 200 && (r.Template == "product" || r.Template == "collection") && !strings.HasSuffix(pathOf(r.URL), "/") {
		c.slashSample = r.URL
	}
	for _, link := range h.InternalLinks {
		if len(c.scopedLinks) < 200 && scopedRe.MatchString(pathOf(link)) && !c.scopedSeen[link] {
			c.scopedSeen[link] = true
			c.scopedLinks = append(c.scopedLinks, link)
		}
		if len(c.paginationCan) < 200 && !c.pagSeen[link] {
			if _, ok := paginationPage(link); ok {
				c.pagSeen[link] = true
				c.paginationCan = append(c.paginationCan, link)
			}
		}
	}
}

// ------------------------------------------------------------------------------------------------ run

func (c *Crawler) run() int {
	j := c.job
	failed := func(code, msg string) int {
		c.ev.emit(map[string]any{"type": "error", "code": code, "message": msg})
		c.ev.emit(map[string]any{"type": "done", "state": "failed", "reason": msg, "code": code})
		return 1
	}
	b, _ := url.Parse(j.BaseURL)
	c.siteHost = strings.ToLower(b.Host)
	c.origin = b.Scheme + "://" + b.Host
	c.start = j.StartURL
	c.setPhase("preflight")
	if err := preflightResolve(c.ctx, c.start, j.AllowLoopback); err != nil {
		return failed("blocked", fmt.Sprintf("Refusing to crawl %s: %s", hostOf(c.start), err.Error()))
	}
	// Resolve the site's real address first (http → https, www ↔ non-www).
	if j.ResolveStart {
		r := c.site.request(c.ctx, c.start, reqOpts{})
		if r.FinalStatus != nil && len(r.Chain) > 0 && r.FinalURL != "" {
			if !isSameSite(r.FinalURL, c.siteHost) && !(j.AllowLoopback && hostOf(r.FinalURL) == c.siteHost) {
				return failed("redirect_offsite", fmt.Sprintf("%s redirects to %s, which is a different website. Add %s under Manage websites to crawl it.", c.start, r.FinalURL, hostOf(r.FinalURL)))
			}
			c.resolved = c.start
			fu, _ := url.Parse(r.FinalURL)
			c.origin = fu.Scheme + "://" + fu.Host
			c.siteHost = strings.ToLower(fu.Host)
			c.start = r.FinalURL
		} else if r.Status == nil && r.Error != "" && !strings.HasPrefix(r.Error, "cancelled") {
			c.ev.warn("start_unreachable", fmt.Sprintf("The start URL did not answer (%s); the crawl continues and records the failure.", r.Error))
		}
	}
	c.homepage = c.origin + "/"
	var err error
	if c.pages, err = newGzWriter(filepath.Join(j.WorkDir, "pages.ndjson.gz")); err != nil {
		return failed("io", err.Error())
	}
	if c.sitemapW, err = newGzWriter(filepath.Join(j.WorkDir, "sitemap.ndjson.gz")); err != nil {
		return failed("io", err.Error())
	}
	if !j.TextCore.Disabled {
		tc, terr := startTextCore(j.TextCore, j.WorkDir)
		if terr != nil {
			c.textErr = terr.Error()
			c.ev.warn("textcore_unavailable", "Duplicate-content analysis (Rust text core) is not available: "+terr.Error())
		} else {
			c.text = tc
		}
	}
	stopProgress := make(chan struct{})
	go c.progressLoop(stopProgress)

	// robots.txt
	c.setPhase("robots")
	t := time.Now()
	rb := c.site.request(c.ctx, c.origin+"/robots.txt", reqOpts{ReadBody: true, Accept: "text/plain,*/*;q=0.5"})
	c.robotsInfo = map[string]any{"url": c.origin + "/robots.txt", "status": rb.FinalStatus, "error": rb.Error}
	if rb.FinalStatus == nil {
		c.robotsInfo["status"] = rb.Status
	}
	if rb.FinalStatus != nil && *rb.FinalStatus >= 200 && *rb.FinalStatus < 300 {
		body := string(rb.Body)
		c.robotsInfo["body"] = body
		c.robots = parseRobots(body)
		if j.RespectRobots {
			if _, _, cd := c.robots.groupFor(j.UserAgent); cd > 0 {
				d := time.Duration(cd * float64(time.Second))
				if lim := time.Duration(j.MaxCrawlDelayMs) * time.Millisecond; d > lim {
					d = lim
				}
				c.crawlDelay = d
				c.thr.setFloor(d)
			}
		}
	} else {
		c.robots = parseRobots("")
	}
	c.timings["robotsMs"] = int(time.Since(t).Milliseconds())

	// Sitemaps: in a full crawl they load in the background while link discovery runs; a smart crawl needs them first
	// to prioritise.
	roots := []string{}
	for _, s := range c.robots.Sitemaps {
		if isSameSite(s, c.siteHost) {
			roots = append(roots, s)
		}
	}
	if len(roots) == 0 {
		roots = []string{c.origin + "/sitemap.xml"}
	}
	runSitemaps := func() {
		defer close(c.sitemapDone)
		if !j.needs("sitemap") {
			return
		}
		t := time.Now()
		res := fetchSitemaps(c.ctx, c.site, roots, j.MaxSitemapFiles, int64(j.MaxSitemapBytes), 2, func(e SitemapEntry) {
			c.sitemapW.write(e)
			c.sitemapURLs++
			if !isSameSite(e.URL, c.siteHost) {
				return
			}
			c.mu.Lock()
			if c.discover(e.URL, srcSitemap, -1, -1) {
				c.cond.Broadcast()
			}
			if st := c.urls[normalizeKey(e.URL)]; st != nil && e.Lastmod != "" && st.lastmod == "" {
				st.lastmod = e.Lastmod
			}
			c.mu.Unlock()
		}, func(f SitemapFile) {
			c.ev.emit(map[string]any{"type": "sitemap", "file": f})
		})
		c.sitemapRes = res
		c.timings["sitemapMs"] = int(time.Since(t).Milliseconds())
		if len(res.Files) > 0 {
			reachable := 0
			for _, f := range res.Files {
				if f.Kind == "urlset" || f.Kind == "sitemapindex" {
					reachable++
				}
			}
			if reachable == 0 {
				c.ev.warn("sitemap_unavailable", fmt.Sprintf("No sitemap could be read (%s: %s). Pages are discovered through links only.", res.Files[0].URL, res.Files[0].Error))
			}
		}
	}

	c.mu.Lock()
	c.discovery = true
	c.mu.Unlock()
	if j.Mode == "smart" {
		c.setPhase("sitemaps")
		runSitemaps()
		c.mu.Lock()
		for _, s := range j.Seeds {
			if !isSameSite(s.URL, c.siteHost) {
				continue
			}
			key := normalizeKey(s.URL)
			c.discover(s.URL, srcSeed, -1, -1)
			if st := c.urls[key]; st != nil {
				st.seedPrio += float32(s.Priority)
				if st.seedWhy == "" {
					st.seedWhy = s.Reason
				}
				if st.state == stQueued {
					st.prio = c.priority(st)
					c.q.push(st)
				}
			}
		}
		c.mu.Unlock()
	} else {
		go runSitemaps()
	}
	c.mu.Lock()
	c.discover(c.start, srcStart, 0, -1)
	c.mu.Unlock()

	c.setPhase("crawling")
	tCrawl := time.Now()
	c.mu.Lock()
	c.lastDone = time.Now()
	c.mu.Unlock()
	c.runWorkers(j.Concurrency)
	if j.Mode == "full" && !c.stopped() && !c.capHit {
		// Sitemap URLs no link reached: crawled now; with no depth limit, their links are followed as well.
		c.setPhase("sitemaps")
		<-c.sitemapDone
		c.mu.Lock()
		c.discovery = false
		released := 0
		for _, st := range c.byID {
			if st.state == stWaiting {
				st.depth = -1
				c.setState(st, stQueued, rNone)
				c.q.push(st)
				released++
			}
		}
		c.mu.Unlock()
		if released > 0 {
			c.setPhase("crawling_sitemap_only")
			// With a depth limit, sitemap-only pages are fetched but their links are not followed (they have no click
			// depth); without one, their links are followed so sections reachable only from them are found too.
			c.noFollow = j.MaxDepth >= 0
			c.runWorkers(j.Concurrency)
		}
	}
	c.timings["crawlMs"] = int(time.Since(tCrawl).Milliseconds())

	// Crawl-budget / pagination / collection-scoped samples, then context checks (skipped after a stop).
	// A user-selected page limit is a hard cap: no extra sample pages are fetched once it is reached.
	if !c.stopped() && !c.capHit {
		c.setPhase("samples")
		c.samples()
	}
	ctxOut := map[string]any{}
	if !c.stopped() {
		c.setPhase("checks")
		t := time.Now()
		ctxOut = c.contextChecks()
		c.timings["checksMs"] = int(time.Since(t).Milliseconds())
	}
	// The sitemap reader must have finished before its file is closed (after a stop it ends at its next request).
	<-c.sitemapDone

	// Final coverage states.
	c.setPhase("finalizing")
	why := c.stopWhy.Load().(string)
	c.mu.Lock()
	for _, st := range c.byID {
		switch st.state {
		case stQueued, stWaiting, stActive:
			if why != "" {
				c.setState(st, stNotProcessed, rNone)
			} else if c.capHit || st.state == stWaiting {
				c.setState(st, stLimit, rNone)
			} else {
				c.setState(st, stNotProcessed, rNone)
			}
		}
	}
	c.mu.Unlock()
	close(stopProgress)

	textOK := false
	if c.text != nil {
		c.setPhase("text_analysis")
		t := time.Now()
		if why != "" && why != "resource" && why != "memory" && why != "stalled" {
			c.text.kill()
			c.textErr = "not run: the crawl was cancelled"
		} else if err := c.text.finish(10 * time.Minute); err != nil {
			c.textErr = err.Error()
			c.ev.warn("textcore_failed", "Duplicate-content analysis failed: "+err.Error())
		} else {
			textOK = true
		}
		c.timings["textMs"] = int(time.Since(t).Milliseconds())
	}
	if err := c.pages.close(); err != nil {
		return failed("io", "writing page results failed: "+err.Error())
	}
	c.sitemapW.close()
	c.writeURLs()

	state, reason := "completed", ""
	switch {
	case why == "user" || why == "parent_gone":
		state, reason = "cancelled", "Cancelled before every discovered URL was fetched."
	case why == "resource" || why == "memory":
		state, reason = "resource_stopped", "Stopped taking new pages because the server's memory limit was close."
	case why == "stalled":
		state, reason = "partial", "Stopped because no request was answered for a long time (the site stopped answering or kept rate limiting). Everything fetched until then is kept."
	case c.capHit && j.Mode == "smart":
		state, reason = "partial", fmt.Sprintf("The Smart Crawl budget of %d pages was reached; %d eligible URLs were not fetched (listed as \"page limit reached\"). Run a Full Crawl to process every eligible URL.", j.MaxPages, c.counts[stLimit])
	case c.capHit:
		state, reason = "partial", fmt.Sprintf("The page limit (%d) was reached; %d eligible URLs were not fetched (listed as \"page limit reached\").", j.MaxPages, c.counts[stLimit])
	case c.counts[stNotProcessed] > 0:
		state, reason = "partial", "Some eligible URLs were not fetched."
	}
	if j.Mode == "smart" && state == "completed" && c.counts[stLimit] > 0 {
		state = "partial"
	}
	ctxOut["robots"] = c.robotsInfo
	ctxOut["sitemap"] = map[string]any{"rootUrls": c.sitemapRes.RootURLs, "files": c.sitemapRes.Files, "entries": c.sitemapURLs, "ms": c.sitemapRes.Ms}
	ctxOut["resolvedStartUrl"] = c.start
	if c.resolved != "" {
		ctxOut["resolvedFrom"] = c.resolved
	}
	ctxOut["origin"] = c.origin
	ctxOut["host"] = c.siteHost
	ctxOut["discoveredBudgetUrls"] = c.budgetURLs
	ctxOut["discoveredBudgetCount"] = c.budgetCount
	ctxOut["bfsTruncated"] = state != "completed" || c.counts[stDepth] > 0
	ctxOut["textCore"] = map[string]any{"ok": textOK, "error": c.textErr}
	ctxOut["timings"] = c.timings
	snap := c.snapshot()
	ctxOut["counts"] = snap
	cb, _ := json.Marshal(ctxOut)
	if err := os.WriteFile(filepath.Join(j.WorkDir, "context.json"), cb, 0o600); err != nil {
		return failed("io", "writing context.json failed: "+err.Error())
	}
	c.ev.emit(map[string]any{"type": "done", "state": state, "reason": reason, "counts": snap, "timings": c.timings, "textCore": textOK, "textCoreError": c.textErr,
		"files": map[string]string{"pages": "pages.ndjson.gz", "urls": "urls.ndjson.gz", "sitemap": "sitemap.ndjson.gz", "context": "context.json", "text": "text.json"}})
	return 0
}

func (c *Crawler) samples() {
	j := c.job
	var todo []struct {
		u, why string
	}
	if j.needs("budget") {
		c.ctxMu.Lock()
		n := 0
		for _, u := range c.budgetURLs {
			if n >= j.Limits.BudgetSamples {
				break
			}
			c.mu.Lock()
			st := c.urls[normalizeKey(u)]
			fetched := st != nil && (st.state == stFetched || st.state == stRobots)
			c.mu.Unlock()
			if fetched {
				continue
			}
			if br := budgetReason(u); br != "" {
				todo = append(todo, struct{ u, why string }{u, br})
				n++
			}
		}
		c.ctxMu.Unlock()
	}
	add := func(list []string, limit int, why string) {
		n := 0
		for _, u := range list {
			if n >= limit {
				return
			}
			c.mu.Lock()
			st := c.urls[normalizeKey(u)]
			done := st != nil && (st.state == stFetched || st.state == stRobots || st.state == stActive)
			c.mu.Unlock()
			if !done {
				todo = append(todo, struct{ u, why string }{u, why})
				n++
			}
		}
	}
	if j.needs("pagination") {
		add(c.paginationCan, j.Limits.PaginationSamples, "")
	}
	if j.needs("collectionScoped") {
		add(c.scopedLinks, j.Limits.CollectionScopedSamples, "")
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, j.Concurrency)
	g := c.group("samples", len(todo))
	for _, t := range todo {
		if c.stopped() {
			break
		}
		c.mu.Lock()
		key := normalizeKey(t.u)
		st := c.urls[key]
		if st == nil {
			st = &uState{id: int32(len(c.byID)), url: key, depth: -1, src: srcLink, from: -1}
			c.urls[key] = st
			c.byID = append(c.byID, st)
			c.setState(st, stQueued, rNone)
		}
		if st.state == stFetched || st.state == stActive {
			c.mu.Unlock()
			g.done.Add(1)
			continue
		}
		if c.robots != nil && j.RespectRobots {
			u, _ := url.Parse(key)
			pq := u.EscapedPath()
			if u.RawQuery != "" {
				pq += "?" + u.RawQuery
			}
			if ok, _ := c.robots.allowed(j.UserAgent, pq); !ok {
				c.mu.Unlock()
				g.done.Add(1)
				continue
			}
		}
		c.setState(st, stActive, rNone)
		c.mu.Unlock()
		wg.Add(1)
		sem <- struct{}{}
		go func(st *uState, why string) {
			defer wg.Done()
			defer func() { <-sem }()
			c.process(st, why, true)
			g.done.Add(1)
		}(st, t.why)
	}
	wg.Wait()
}

func (c *Crawler) checkLink(u string, external bool) LinkStatus {
	cl := c.site
	if external {
		cl = c.ext
	}
	r := cl.request(c.ctx, u, reqOpts{Method: http.MethodHead})
	if (r.FinalStatus != nil && (*r.FinalStatus == 405 || *r.FinalStatus == 501)) || (r.Status == nil && !strings.Contains(r.Error, "timeout") && r.Error != "cancelled" && !strings.HasPrefix(r.Error, "blocked")) {
		r = cl.request(c.ctx, u, reqOpts{Method: http.MethodGet})
	}
	return LinkStatus{URL: u, Status: r.Status, FinalStatus: r.FinalStatus, FinalURL: r.FinalURL, Chain: r.Chain, RedirectLoop: r.RedirectLoop, Error: r.Error}
}

func pool[T any, R any](items []T, n int, fn func(T) R) []R {
	out := make([]R, len(items))
	if n < 1 {
		n = 1
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, n)
	for i, it := range items {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, it T) {
			defer wg.Done()
			defer func() { <-sem }()
			out[i] = fn(it)
		}(i, it)
	}
	wg.Wait()
	return out
}

// maxFacetProbes: filter / sort links (?filter.…, ?sort_by=…) are endless variants of a collection page; a sample of
// them is checked for broken links, not every one (each probe costs one request in the site's polite queue).
const maxFacetProbes = 25

// contextChecks runs the post-crawl checks. The groups run side by side: requests to the website still go through its
// single polite queue (so this never sends more to the site than the crawl did), while CDN images, third-party scripts,
// external links and the TLS handshake use other hosts and no longer wait behind the site's queue one group at a time.
func (c *Crawler) contextChecks() map[string]any {
	j := c.job
	out := map[string]any{}
	set := func(k string, v any) {
		c.outMu.Lock()
		out[k] = v
		c.outMu.Unlock()
	}
	conc := j.Concurrency
	if conc > 8 {
		conc = 8
	}
	var tasks []func()
	// Time budget: requests to a rate-limited site are slow, so the checks get as long as the page crawl took (at least
	// 5, at most 20 minutes) unless the job says otherwise; whatever is left is reported as deferred (not checked),
	// never as broken. The most valuable targets go first (most-linked links, images shown on the most pages).
	budget := time.Duration(j.ChecksBudgetMs) * time.Millisecond
	if budget <= 0 {
		budget = time.Duration(c.timings["crawlMs"]) * time.Millisecond
		if budget < 5*time.Minute {
			budget = 5 * time.Minute
		}
		if budget > 20*time.Minute {
			budget = 20 * time.Minute
		}
	}
	c.checkMu.Lock()
	c.checkDeadline = time.Now().Add(budget)
	c.checkMu.Unlock()
	c.timings["checksBudgetMs"] = int(budget.Milliseconds())

	// Link targets: canonicals, internal links and sitemap entries that were not crawled as pages. URLs the crawl
	// already fetched are answered by the crawl (reused, no request); the rest are checked most-linked first.
	if j.needs("linkTargets") || j.needs("sitemap") {
		var targets []string
		seen := map[string]bool{}
		g := c.group("links", 0)
		c.mu.Lock()
		known := func(u string) bool {
			st := c.urls[normalizeKey(u)]
			return st != nil && (st.state == stFetched || st.state == stRobots)
		}
		allowed := func(u string) bool {
			if c.robots == nil || !j.RespectRobots {
				return true
			}
			pu, _ := url.Parse(u)
			pq := pu.EscapedPath()
			if pu.RawQuery != "" {
				pq += "?" + pu.RawQuery
			}
			ok, _ := c.robots.allowed(j.UserAgent, pq)
			return ok
		}
		// classify: 1 = will be checked, 0 = already handled / counted elsewhere.
		add := func(u string) int {
			k := normalizeKey(u)
			if u == "" || seen[k] || !isSameSite(u, c.siteHost) {
				return 0
			}
			seen[k] = true
			switch {
			case known(u):
				g.reused.Add(1)
				return 0
			case !allowed(u):
				g.excluded.Add(1)
				return 0
			}
			targets = append(targets, u)
			return 1
		}
		if j.needs("linkTargets") {
			c.ctxMu.Lock()
			for _, cn := range c.canonOrder {
				add(cn)
			}
			c.ctxMu.Unlock()
			var cands []*uState
			for _, st := range c.byID {
				if st.src&srcLink == 0 || st.state == stFetched || st.state == stRobots {
					continue
				}
				// Never probe URLs excluded as traps, by your settings or as non-pages; filter / sort variants only
				// as a sample.
				if st.state == stExcluded && st.reason != rFacet {
					g.excluded.Add(1)
					continue
				}
				cands = append(cands, st)
			}
			// Most-linked targets first: a broken URL linked from every page matters more than one linked once.
			sort.SliceStable(cands, func(a, b int) bool { return cands[a].inlinks > cands[b].inlinks })
			n, facets := 0, 0
			for _, st := range cands {
				isFacet := st.state == stExcluded && st.reason == rFacet
				if isFacet && facets >= maxFacetProbes {
					g.excluded.Add(1) // filter / sort variants are sampled on purpose
					continue
				}
				if n >= j.Limits.LinkChecks {
					g.skip()
					continue
				}
				if r := add(st.url); r == 1 {
					n++
					if isFacet {
						facets++
					}
				}
			}
		}
		if j.needs("sitemap") {
			n := 0
			for _, st := range c.byID {
				if st.src&srcSitemap == 0 {
					continue
				}
				if n >= j.Limits.SitemapChecks {
					if k := normalizeKey(st.url); !seen[k] && !known(st.url) {
						seen[k] = true
						g.skip()
					}
					continue
				}
				n += add(st.url)
			}
		}
		c.mu.Unlock()
		g.total.Add(int64(len(targets)))
		tasks = append(tasks, func() {
			set("linkTargets", gcheck(c, g, targets, conc, func(u string) (LinkStatus, int) {
				r := c.checkLink(u, false)
				return r, outcomeOf(r.FinalStatus)
			}))
		})
	}
	c.ctxMu.Lock()
	images, externals, scripts, slash := append([]string{}, c.images...), append([]string{}, c.externals...), append([]string{}, c.scripts...), c.slashSample
	counts := make(map[string]int, len(c.imageCount))
	for k, v := range c.imageCount {
		counts[k] = v
	}
	imagesOver := len(c.imagesOver)
	c.ctxMu.Unlock()
	if j.needs("images") {
		// Images shown on the most pages first.
		sort.SliceStable(images, func(a, b int) bool { return counts[images[a]] > counts[images[b]] })
		g := c.group("images", len(images))
		for i := 0; i < imagesOver; i++ {
			g.skip()
		}
		if imagesOver >= 20000 {
			g.atLeast.Store(true)
		}
		tasks = append(tasks, func() {
			set("images", gcheck(c, g, images, conc, func(u string) (AssetInfo, int) {
				cl := c.ext // CDN-hosted images: paced per host, not in the site's queue
				if isSameSite(u, c.siteHost) {
					cl = c.site
				}
				st, sz, ct, e := cl.assetSize(c.ctx, u, "image/avif,image/webp,image/*,*/*;q=0.8")
				return AssetInfo{URL: u, Status: st, Bytes: sz, ContentType: ct, Error: e}, outcomeOf(st)
			}))
		})
	}
	if j.needs("external") {
		g := c.group("external", len(externals))
		tasks = append(tasks, func() {
			set("externalLinks", gcheck(c, g, externals, conc, func(u string) (AssetInfo, int) {
				r := c.checkLink(u, true)
				return AssetInfo{URL: u, Status: r.FinalStatus, Error: r.Error}, outcomeOf(r.FinalStatus)
			}))
		})
	}
	if j.needs("scripts") {
		g := c.group("scripts", len(scripts))
		tasks = append(tasks, func() {
			set("scripts", gcheck(c, g, scripts, conc, func(u string) (AssetInfo, int) {
				st, sz, ct, e := c.ext.assetSize(c.ctx, u, "*/*")
				return AssetInfo{URL: u, Status: st, Bytes: sz, ContentType: ct, Error: e}, outcomeOf(st)
			}))
		})
	}
	local := j.AllowLoopback && (strings.HasPrefix(c.siteHost, "localhost") || strings.HasPrefix(c.siteHost, "127.") || strings.HasPrefix(c.siteHost, "[::1]"))
	if j.needs("botProbe") && len(j.BotProbes) > 0 {
		g := c.group("botProbes", len(j.BotProbes))
		tasks = append(tasks, func() {
			set("botProbes", gpool(g, j.BotProbes, 2, func(b BotProbe) map[string]any {
				r := c.site.request(c.ctx, c.homepage, reqOpts{UserAgent: b.UserAgent, NoRetry: true})
				st := r.FinalStatus
				if st == nil {
					st = r.Status
				}
				return map[string]any{"bot": b.Bot, "userAgent": b.UserAgent, "status": st, "error": r.Error}
			}))
		})
	}
	if j.needs("host") && !local {
		u, _ := url.Parse(c.origin)
		bare := strings.TrimPrefix(u.Hostname(), "www.")
		port := ""
		if u.Port() != "" {
			port = ":" + u.Port()
		}
		var variants []string
		for _, h := range []string{bare, "www." + bare} {
			for _, p := range []string{"https:", "http:"} {
				variants = append(variants, p+"//"+h+port+"/")
			}
		}
		n := len(variants)
		if slash != "" {
			n++
		}
		g := c.group("host", n)
		tasks = append(tasks, func() {
			set("hostVariants", gpool(g, variants, 2, func(v string) HostVariant {
				r := c.site.request(c.ctx, v, reqOpts{})
				return HostVariant{URL: v, IsCanonical: strings.TrimRight(v, "/") == strings.TrimRight(c.homepage, "/"), Status: r.Status, FinalStatus: r.FinalStatus, FinalURL: r.FinalURL, Chain: r.Chain, Error: r.Error}
			}))
			if slash != "" {
				variant := strings.SplitN(slash, "?", 2)[0] + "/"
				r := c.site.request(c.ctx, variant, reqOpts{ReadBody: true})
				ts := map[string]any{"url": slash, "variant": variant, "status": r.Status}
				if r.FinalStatus != nil && *r.FinalStatus == 200 && r.Body != nil {
					if p := extractHTML(r.Body, r.FinalURL, c.siteHost); p != nil && len(p.Canonicals) > 0 {
						ts["canonical"] = p.Canonicals[0]
					}
				}
				canon, _ := ts["canonical"].(string)
				if r.Status != nil && *r.Status == 200 && (canon == "" || strings.HasSuffix(canon, "/")) && normalizeKey(canon) != normalizeKey(slash) {
					ts["problem"] = "trailing-slash variant resolves 200 without a canonical to the slash-less URL"
				}
				set("trailingSlash", ts)
				g.done.Add(1)
			}
		})
	}
	if j.needs("tls") && !local && !j.SkipTLS && strings.HasPrefix(c.origin, "https:") {
		g := c.group("tls", 1)
		tasks = append(tasks, func() {
			u, _ := url.Parse(c.origin)
			set("tls", c.checkTLS(u.Hostname(), u.Port()))
			g.done.Add(1)
		})
	}
	var wg sync.WaitGroup
	for _, t := range tasks {
		wg.Add(1)
		go func(t func()) {
			defer wg.Done()
			t()
		}(t)
	}
	wg.Wait()
	out["checkStats"] = c.checkProgress()
	return out
}

func (c *Crawler) checkTLS(host, port string) TLSInfo {
	if port == "" {
		port = "443"
	}
	info := TLSInfo{Host: host}
	d := guardedDialer(c.job.AllowLoopback, time.Duration(c.job.TimeoutMs)*time.Millisecond)
	conn, err := tls.DialWithDialer(d, "tcp", net.JoinHostPort(host, port), &tls.Config{ServerName: host, InsecureSkipVerify: true})
	if err != nil {
		info.Error = err.Error()
		return info
	}
	defer conn.Close()
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		info.Error = "no peer certificate presented"
		return info
	}
	leaf := certs[0]
	info.ValidTo = leaf.NotAfter.UTC().Format("2006-01-02T15:04:05.000Z")
	days := int(time.Until(leaf.NotAfter).Hours() / 24)
	info.DaysLeft = &days
	inter := x509.NewCertPool()
	for _, ct := range certs[1:] {
		inter.AddCert(ct)
	}
	_, verr := leaf.Verify(x509.VerifyOptions{DNSName: host, Intermediates: inter})
	auth := verr == nil
	info.Authorized = &auth
	if verr != nil {
		info.AuthorizationError = verr.Error()
	}
	return info
}

func (c *Crawler) writeURLs() {
	w, err := newGzWriter(filepath.Join(c.job.WorkDir, "urls.ndjson.gz"))
	if err != nil {
		c.ev.warn("io", "could not write the URL coverage file: "+err.Error())
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, st := range c.byID {
		r := URLRecord{URL: st.url, State: stateNames[st.state], Reason: reasonNames[st.reason], FoundVia: sourceList(st.src), FoundOn: c.urlOf(st.from), Template: templateOf(st.url),
			Inlinks: st.inlinks, Robots: st.robots, Trap: st.trap, Lastmod: st.lastmod, InSitemap: st.src&srcSitemap != 0}
		if c.job.Mode == "smart" {
			r.Priority = st.prio
		}
		if st.depth >= 0 {
			r.Depth = intp(int(st.depth))
		}
		w.write(r)
	}
	if err := w.close(); err != nil {
		c.ev.warn("io", "writing the URL coverage file failed: "+err.Error())
	}
}

// ------------------------------------------------------------------------------------------------ progress

func (c *Crawler) snapshot() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	perMin := 0
	for i := len(c.completions) - 1; i >= 0; i-- {
		if now.Sub(c.completions[i]) > time.Minute {
			break
		}
		perMin++
	}
	window := now.Sub(c.t0)
	if window < time.Minute && window > 5*time.Second {
		perMin = int(float64(perMin) / window.Minutes())
	}
	excl := map[string]int{}
	for r, n := range c.excluded {
		if n > 0 {
			excl[reasonNames[r]] = n
		}
	}
	interval, floor, slowDowns, waited := c.thr.snapshot()
	reqs := c.site.done.Load() + c.ext.done.Load()
	last := c.site.lastDone.Load()
	if l := c.ext.lastDone.Load(); l > last {
		last = l
	}
	if !c.lastDone.IsZero() && c.lastDone.UnixMilli() > last {
		last = c.lastDone.UnixMilli()
	}
	rpm := int64(0)
	for _, rs := range c.reqSamples {
		if now.Sub(rs.t) <= time.Minute {
			rpm = reqs - rs.n
			if el := now.Sub(rs.t); el > 5*time.Second && el < time.Minute {
				rpm = int64(float64(rpm) / el.Minutes())
			}
			break
		}
	}
	var lastAt any
	if last > 0 {
		lastAt = time.UnixMilli(last).UTC().Format(time.RFC3339Nano)
	}
	return map[string]any{
		"requests":       reqs,
		"requestsPerMin": rpm,
		"lastRequestAt":  lastAt,
		"discovered":     len(c.byID),
		"queued":         c.counts[stQueued],
		"waiting":        c.counts[stWaiting],
		"active":         c.counts[stActive],
		"processed":      c.processed,
		"succeeded":      c.succeeded,
		"failed":         c.failed,
		"robots":         c.counts[stRobots],
		"depthLimited":   c.counts[stDepth],
		"pageLimited":    c.counts[stLimit],
		"excluded":       c.counts[stExcluded],
		"excludedBy":     excl,
		"notProcessed":   c.counts[stNotProcessed],
		"pagesPerMin":    perMin,
		"sitemapUrls":    c.sitemapURLs,
		"politeness": map[string]any{"delayMs": interval.Milliseconds(), "floorMs": floor.Milliseconds(), "crawlDelayMs": c.crawlDelay.Milliseconds(), "slowDowns": slowDowns,
			"retries": c.site.retries.Load() + c.ext.retries.Load(), "rateLimited": c.site.rate429.Load(), "unavailable503": c.site.rate503.Load(), "limitedAnswers": c.thr.limitedCount(), "retryAfterPauses": c.thr.pauseCount(),
			"waitedMs": waited.Milliseconds(), "avgLatencyMs": c.site.latency.avg()},
		"checks":    c.checkProgress(),
		"elapsedMs": now.Sub(c.t0).Milliseconds(),
	}
}

func (c *Crawler) progressLoop(stop chan struct{}) {
	tick := time.NewTicker(time.Duration(c.job.ProgressMs) * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
		}
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		heapMB := float64(m.HeapAlloc) / 1048576
		goRSS := rssMB(os.Getpid())
		textRSS := -1.0
		if c.text != nil {
			textRSS = rssMB(c.text.pid)
		}
		if goRSS > c.memPeakMB {
			c.memPeakMB = goRSS
		}
		if textRSS > c.textPeakMB {
			c.textPeakMB = textRSS
		}
		// Resource guard: confirm after a collection, then stop taking new pages (results so far are kept).
		if c.job.MemoryLimitMB > 0 && heapMB > float64(c.job.MemoryLimitMB)*0.9 {
			runtime.GC()
			runtime.ReadMemStats(&m)
			if float64(m.HeapAlloc)/1048576 > float64(c.job.MemoryLimitMB)*0.9 {
				c.ev.warn("memory", fmt.Sprintf("Crawler heap %.0f MB is near its %d MB limit: no new pages will be taken.", float64(m.HeapAlloc)/1048576, c.job.MemoryLimitMB))
				c.stop("memory")
			}
		}
		c.mu.Lock()
		c.reqSamples = append(c.reqSamples, reqSample{t: time.Now(), n: c.site.done.Load() + c.ext.done.Load()})
		if len(c.reqSamples) > 90 {
			c.reqSamples = c.reqSamples[len(c.reqSamples)-90:]
		}
		c.mu.Unlock()
		snap := c.snapshot()
		snap["type"] = "progress"
		snap["phase"] = c.phase
		snap["memory"] = map[string]any{"goRssMB": round1(goRSS), "goHeapMB": round1(heapMB), "textCoreRssMB": round1(textRSS), "goPeakMB": round1(c.memPeakMB), "textCorePeakMB": round1(c.textPeakMB)}
		c.ev.emit(snap)
		// Stall diagnostics, in every phase (page fetches, samples, post-crawl checks, sitemaps): nothing has been
		// answered for longer than the current gap + timeout allows, while work is still open.
		interval, _, _, _ := c.thr.snapshot()
		minStall := c.stallMin
		if minStall == 0 {
			minStall = 90 * time.Second
		}
		stallAfter := 2*interval + time.Duration(c.job.TimeoutMs)*time.Millisecond + minStall/6
		if stallAfter < minStall {
			stallAfter = minStall
		}
		last := c.site.lastDone.Load()
		if l := c.ext.lastDone.Load(); l > last {
			last = l
		}
		c.mu.Lock()
		if lt := c.lastDone.UnixMilli(); !c.lastDone.IsZero() && lt > last {
			last = lt
		}
		phase := c.phase
		since := time.Since(time.UnixMilli(last))
		var stuck []map[string]any
		warn := last > 0 && since > stallAfter && time.Since(c.stallWarned) > 2*time.Minute && phase != "finalizing" && phase != "text_analysis" && phase != "preflight"
		if warn {
			for id, t := range c.activeSince {
				if len(stuck) >= 5 {
					break
				}
				stuck = append(stuck, map[string]any{"url": c.byID[id].url, "seconds": int(time.Since(t).Seconds())})
			}
			c.stallWarned = time.Now()
		}
		c.mu.Unlock()
		if warn {
			cp := c.checkProgress()
			c.ev.emit(map[string]any{"type": "warning", "code": "stalled", "phase": phase, "message": fmt.Sprintf("No request has been answered for %d s (phase: %s, gap between requests: %d ms, checks %v of %v done). The site may be rate limiting or a request is hanging until its timeout.", int(since.Seconds()), phase, interval.Milliseconds(), cp["done"], cp["total"]), "active": stuck})
		}
	}
}
