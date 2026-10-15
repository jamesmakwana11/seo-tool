package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// RedirectHop is one redirect in a chain.
type RedirectHop struct {
	URL      string `json:"url"`
	Status   int    `json:"status"`
	Location string `json:"location"`
}

// FetchResult mirrors the Node API's FetchResult (JSON field names are the protocol).
type FetchResult struct {
	URL              string            `json:"url"`
	FinalURL         string            `json:"finalUrl"`
	Status           *int              `json:"status"`
	FinalStatus      *int              `json:"finalStatus"`
	Chain            []RedirectHop     `json:"chain"`
	RedirectLoop     bool              `json:"redirectLoop"`
	TooManyRedirects bool              `json:"tooManyRedirects"`
	ResponseMs       *int              `json:"responseMs,omitempty"`
	FinalResponseMs  *int              `json:"finalResponseMs,omitempty"`
	TotalMs          int               `json:"totalMs"`
	Error            string            `json:"error,omitempty"`
	Headers          map[string]string `json:"headers"`
	ContentType      string            `json:"contentType,omitempty"`
	Bytes            *int              `json:"bytes,omitempty"`
	Truncated        bool              `json:"truncated,omitempty"`
	Body             []byte            `json:"-"`
}

func intp(v int) *int { return &v }

// ------------------------------------------------------------------------------------------- adaptive throttle

// throttle spaces request starts for one crawl (politeness). 429/503 answers widen the gap (at least doubling it, or
// following Retry-After, up to maxMs); a run of normal answers narrows it again quickly (×0.75 every 5 answers) so a
// short burst of rate limiting does not leave the crawl crawling at one request per 30 s for many minutes.
type throttle struct {
	mu        sync.Mutex
	next      time.Time
	lastStart time.Time
	floor     time.Duration
	interval  time.Duration
	maxD      time.Duration
	okRun     int
	slowDowns int64
	waited    time.Duration
}

func newThrottle(min, max time.Duration) *throttle {
	if max < min {
		max = min
	}
	return &throttle{floor: min, interval: min, maxD: max}
}

func (t *throttle) wait(ctx context.Context) error {
	t.mu.Lock()
	now := time.Now()
	if t.interval <= 0 {
		t.lastStart = now
		t.mu.Unlock()
		return ctx.Err()
	}
	at := now
	if t.next.After(at) {
		at = t.next
	}
	t.lastStart = at
	t.next = at.Add(t.interval)
	d := at.Sub(now)
	t.waited += d
	t.mu.Unlock()
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (t *throttle) slowDown(retryAfter time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.slowDowns++
	t.okRun = 0
	n := t.interval * 2
	if n < time.Second {
		n = time.Second
	}
	if retryAfter > n {
		n = retryAfter
	}
	if n < t.floor {
		n = t.floor
	}
	if n > t.maxD {
		n = t.maxD
	}
	t.interval = n
	if nx := t.lastStart.Add(n); nx.After(t.next) {
		t.next = nx
	}
}

func (t *throttle) relax() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.interval <= t.floor {
		return
	}
	t.okRun++
	if t.okRun >= 5 {
		t.okRun = 0
		n := t.interval * 3 / 4
		// Close to the configured gap: go straight back to it.
		if n < t.floor || n-t.floor < 100*time.Millisecond {
			n = t.floor
		}
		t.interval = n
	}
}

func (t *throttle) setFloor(d time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if d > t.maxD {
		d = t.maxD
	}
	if d > t.floor {
		t.floor = d
	}
	if t.interval < t.floor {
		t.interval = t.floor
	}
	if nx := t.lastStart.Add(t.interval); nx.After(t.next) {
		t.next = nx
	}
}

func (t *throttle) snapshot() (interval, floor time.Duration, slowDowns int64, waited time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.interval, t.floor, t.slowDowns, t.waited
}

// ------------------------------------------------------------------------------------------- client

type clientOpts struct {
	UserAgent      string
	Timeout        time.Duration
	MaxBody        int
	MaxRedirects   int
	Retries        int
	MaxRetryWait   time.Duration
	AllowLoopback  bool
	Throttle       *throttle // nil = unthrottled (other websites)
	Concurrency    int
	OnRetry        func()
	OnStatus       func(status int)
	Transport      http.RoundTripper // tests
	InsecureTLSFor string            // never set in production
}

type reqOpts struct {
	Method         string
	ReadBody       bool
	NoFollow       bool
	NoRetry        bool // measurements: record the first answer, do not touch the pace
	Accept         string
	UserAgent      string
	MaxBody        int
	AnyContentType bool
	Gunzip         bool
}

type httpClient struct {
	o       clientOpts
	c       *http.Client
	retries atomic.Int64
	rate429 atomic.Int64
	latency latencyStats
}

type latencyStats struct {
	mu    sync.Mutex
	n     int64
	sumMs int64
}

func (l *latencyStats) add(ms int) {
	l.mu.Lock()
	l.n++
	l.sumMs += int64(ms)
	l.mu.Unlock()
}
func (l *latencyStats) avg() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.n == 0 {
		return 0
	}
	return int(l.sumMs / l.n)
}

func newHTTPClient(o clientOpts) *httpClient {
	if o.MaxRedirects == 0 {
		o.MaxRedirects = 5
	}
	if o.MaxBody == 0 {
		o.MaxBody = 5 << 20
	}
	tr := o.Transport
	if tr == nil {
		per := o.Concurrency + 2
		if per < 4 {
			per = 4
		}
		tr = &http.Transport{
			Proxy:                 nil, // direct connections only: a proxy would bypass the address checks
			DialContext:           guardedDialer(o.AllowLoopback, o.Timeout).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          64,
			MaxIdleConnsPerHost:   per, // keep-alive: connections to the site are reused
			IdleConnTimeout:       60 * time.Second,
			TLSHandshakeTimeout:   o.Timeout,
			ResponseHeaderTimeout: o.Timeout,
			ExpectContinueTimeout: time.Second,
			TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		}
	}
	return &httpClient{o: o, c: &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

var retryStatus = map[int]bool{429: true, 502: true, 503: true, 504: true}
// Certificate problems are not transient: retrying them only slows the crawl down.
var noRetryErr = regexp.MustCompile(`(?i)^(cancelled|blocked:|could not resolve|more than \d+ redirects)|no such host|invalid Location|server misbehaving|x509:|tls: failed to verify|certificate`)

func retryAfter(v string, now time.Time) (time.Duration, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, false
	}
	if n, err := strconv.Atoi(v); err == nil && n >= 0 {
		return time.Duration(n) * time.Second, true
	}
	if t, err := http.ParseTime(v); err == nil {
		d := t.Sub(now)
		if d < 0 {
			d = 0
		}
		return d, true
	}
	return 0, false
}

type single struct {
	status  int
	headers http.Header
	ms      int
	body    []byte
	bytes   *int
	trunc   bool
	err     string
}

func describeErr(err error, timedOut bool, timeout time.Duration) string {
	if timedOut {
		return fmt.Sprintf("timeout after %dms", timeout.Milliseconds())
	}
	if isBlocked(err) {
		var b *blockedError
		errors.As(err, &b)
		return b.msg
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return fmt.Sprintf("ENOTFOUND: could not resolve %s", dnsErr.Name)
	}
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		err = ue.Err
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection reset"):
		return "ECONNRESET: " + msg
	case strings.Contains(msg, "connection refused"):
		return "ECONNREFUSED: " + msg
	case strings.Contains(msg, "EOF"):
		return "ECONNRESET: connection closed (" + msg + ")"
	}
	return msg
}

var textual = regexp.MustCompile(`(?i)(text/|html|xml|json|javascript)`)

func (h *httpClient) once(ctx context.Context, target string, ro reqOpts) single {
	if ctx.Err() != nil {
		return single{err: "cancelled"}
	}
	if err := checkURL(target, h.o.AllowLoopback); err != nil {
		return single{err: err.Error()}
	}
	if h.o.Throttle != nil {
		if err := h.o.Throttle.wait(ctx); err != nil {
			return single{err: "cancelled"}
		}
	}
	rctx, cancel := context.WithTimeout(ctx, h.o.Timeout)
	defer cancel()
	method := ro.Method
	if method == "" {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(rctx, method, target, nil)
	if err != nil {
		return single{err: err.Error()}
	}
	ua := h.o.UserAgent
	if ro.UserAgent != "" {
		ua = ro.UserAgent
	}
	req.Header.Set("User-Agent", ua)
	acc := ro.Accept
	if acc == "" {
		acc = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	}
	req.Header.Set("Accept", acc)
	t0 := time.Now()
	res, err := h.c.Do(req)
	if err != nil {
		timedOut := errors.Is(rctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil
		if ctx.Err() != nil {
			return single{err: "cancelled", ms: int(time.Since(t0).Milliseconds())}
		}
		return single{err: describeErr(err, timedOut, h.o.Timeout), ms: int(time.Since(t0).Milliseconds())}
	}
	defer res.Body.Close()
	ms := int(time.Since(t0).Milliseconds())
	h.latency.add(ms)
	s := single{status: res.StatusCode, headers: res.Header, ms: ms}
	isRedirect := res.StatusCode >= 300 && res.StatusCode < 400 && res.Header.Get("Location") != ""
	ct := res.Header.Get("Content-Type")
	if ro.ReadBody && !isRedirect && (textual.MatchString(ct) || ct == "" || ro.AnyContentType) && method == http.MethodGet {
		limit := ro.MaxBody
		if limit == 0 {
			limit = h.o.MaxBody
		}
		buf, cut, rerr := readLimited(res.Body, limit)
		if rerr != nil && len(buf) == 0 {
			if ctx.Err() != nil {
				return single{err: "cancelled", ms: ms}
			}
			timedOut := errors.Is(rctx.Err(), context.DeadlineExceeded)
			return single{status: res.StatusCode, headers: res.Header, ms: ms, err: describeErr(rerr, timedOut, h.o.Timeout)}
		}
		n := len(buf)
		s.bytes = &n
		if ro.Gunzip && len(buf) > 2 && buf[0] == 0x1f && buf[1] == 0x8b {
			if cut {
				s.trunc = true
				s.err = fmt.Sprintf("compressed file larger than %d MB", limit>>20)
				return s
			}
			zr, zerr := gzip.NewReader(bytes.NewReader(buf))
			if zerr != nil {
				s.err = "could not decompress gzip body: " + zerr.Error()
				return s
			}
			out, cut2, derr := readLimited(zr, limit)
			if derr != nil {
				s.err = "could not decompress gzip body: " + derr.Error()
				return s
			}
			buf, cut = out, cut2
		}
		s.body = buf
		s.trunc = cut
	} else {
		if cl, err := strconv.Atoi(res.Header.Get("Content-Length")); err == nil {
			s.bytes = &cl
		}
		_, _ = io.CopyN(io.Discard, res.Body, 64<<10) // let the connection be reused when the remainder is small
	}
	return s
}

func readLimited(r io.Reader, limit int) ([]byte, bool, error) {
	var b bytes.Buffer
	n, err := io.CopyN(&b, r, int64(limit)+1)
	if err != nil && err != io.EOF {
		return b.Bytes(), false, err
	}
	if n > int64(limit) {
		return b.Bytes()[:limit], true, nil
	}
	return b.Bytes(), false, nil
}

// attempt: one hop with retries for transient failures; feeds the adaptive throttle.
func (h *httpClient) attempt(ctx context.Context, target string, ro reqOpts) single {
	for n := 0; ; n++ {
		s := h.once(ctx, target, ro)
		ra, hasRA := retryAfter(s.headers.Get("Retry-After"), time.Now())
		if !ro.NoRetry && h.o.Throttle != nil {
			if s.status == 429 || s.status == 503 {
				if s.status == 429 {
					h.rate429.Add(1)
				}
				h.o.Throttle.slowDown(ra)
			} else if s.status != 0 && s.status < 500 {
				h.o.Throttle.relax()
			}
		}
		if h.o.OnStatus != nil && s.status != 0 {
			h.o.OnStatus(s.status)
		}
		transient := false
		if s.status != 0 {
			transient = retryStatus[s.status]
		} else if s.err != "" {
			transient = !noRetryErr.MatchString(s.err)
		}
		if ro.NoRetry || n >= h.o.Retries || !transient || ctx.Err() != nil {
			return s
		}
		wait := time.Duration(1000*(1<<n))*time.Millisecond + time.Duration(rand.Intn(250))*time.Millisecond
		if hasRA {
			wait = ra
		}
		if wait > h.o.MaxRetryWait {
			return s // the site asked for a longer pause than we wait per page: record its answer
		}
		h.retries.Add(1)
		if h.o.OnRetry != nil {
			h.o.OnRetry()
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return s
		case <-timer.C:
		}
	}
}

func headerMap(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, v := range h {
		out[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	return out
}

// request fetches target following redirects manually (each hop re-checked), recording the chain honestly.
func (h *httpClient) request(ctx context.Context, target string, ro reqOpts) FetchResult {
	start := time.Now()
	res := FetchResult{URL: target, FinalURL: target, Chain: []RedirectHop{}, Headers: map[string]string{}}
	seen := map[string]bool{target: true}
	cur := target
	for {
		s := h.attempt(ctx, cur, ro)
		if res.ResponseMs == nil {
			res.ResponseMs = intp(s.ms)
		}
		if s.status == 0 {
			res.FinalURL = cur
			res.FinalResponseMs = intp(s.ms)
			res.Error = s.err
			res.TotalMs = int(time.Since(start).Milliseconds())
			return res
		}
		if res.Status == nil {
			res.Status = intp(s.status)
		}
		headers := headerMap(s.headers)
		loc := headers["location"]
		if s.status >= 300 && s.status < 400 && loc != "" && !ro.NoFollow {
			next, ok := resolveURL(loc, cur)
			if !ok {
				res.FinalURL = cur
				res.FinalStatus = intp(s.status)
				res.Error = "invalid Location header: " + loc
				res.Headers = headers
				res.FinalResponseMs = intp(s.ms)
				res.TotalMs = int(time.Since(start).Milliseconds())
				return res
			}
			res.Chain = append(res.Chain, RedirectHop{URL: cur, Status: s.status, Location: next})
			if seen[next] {
				res.FinalURL = next
				res.RedirectLoop = true
				res.Error = "redirect loop"
				res.Headers = headers
				res.TotalMs = int(time.Since(start).Milliseconds())
				return res
			}
			if len(res.Chain) >= h.o.MaxRedirects {
				res.FinalURL = next
				res.TooManyRedirects = true
				res.Error = fmt.Sprintf("more than %d redirects", h.o.MaxRedirects)
				res.Headers = headers
				res.TotalMs = int(time.Since(start).Milliseconds())
				return res
			}
			seen[next] = true
			cur = next
			continue
		}
		res.FinalURL = cur
		res.FinalStatus = intp(s.status)
		res.FinalResponseMs = intp(s.ms)
		res.Headers = headers
		res.ContentType = headers["content-type"]
		res.Body = s.body
		res.Bytes = s.bytes
		res.Truncated = s.trunc
		if s.err != "" {
			res.Error = s.err
		}
		res.TotalMs = int(time.Since(start).Milliseconds())
		return res
	}
}

// assetSize: HEAD content-length, else a GET counting bytes (capped at 20 MB, body discarded).
func (h *httpClient) assetSize(ctx context.Context, target string, accept string) (status *int, size *int, ctype string, errMsg string) {
	head := h.request(ctx, target, reqOpts{Method: http.MethodHead, NoRetry: true, Accept: accept})
	if head.FinalStatus != nil && *head.FinalStatus < 400 {
		if cl, err := strconv.Atoi(head.Headers["content-length"]); err == nil {
			return head.FinalStatus, &cl, head.Headers["content-type"], ""
		}
	}
	g := h.request(ctx, target, reqOpts{Method: http.MethodGet, ReadBody: true, AnyContentType: true, MaxBody: 20 << 20, NoRetry: true, Accept: accept})
	st := g.FinalStatus
	if st == nil {
		st = head.FinalStatus
	}
	ct := g.ContentType
	if ct == "" {
		ct = head.Headers["content-type"]
	}
	e := g.Error
	if e == "" {
		e = head.Error
	}
	return st, g.Bytes, ct, e
}
