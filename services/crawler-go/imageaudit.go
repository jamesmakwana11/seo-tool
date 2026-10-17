package main

// Image Audit (job mode "images"): checks a list of unique image URLs that the API extracted from a finished crawl.
// It runs only when a user starts it, never as part of a page crawl.
//
// Per image: robots.txt of the image's host is respected; one GET with "Range: bytes=0-N" reads at most ProbeBytes
// (enough for the format and pixel size); the total size comes from Content-Range / Content-Length, so a full image
// file is never downloaded. Redirects are followed hop by hop (each hop re-checked by the SSRF guard), 429 / 503 slow
// the host down and Retry-After is honoured, the site's own host keeps the crawl's pace and Crawl-delay, other hosts
// get a small per-host gap. Every result is one of:
//
//	ok          the image answered 2xx with image content
//	broken      4xx (not 429), or a 2xx that is not an image (e.g. an HTML error page)
//	failed      5xx, timeout, network or TLS error — inaccessible now, may be temporary
//	unverified  not checked: robots.txt disallows it, its robots.txt could not be read, rate limited after retries,
//	            or a third-party host that is not checked
//	deferred    not checked in this job: the time budget ran out or the job was cancelled
//
// An image is never reported as ok without an actual answer.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const imageAccept = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"

// ImageResult is one checked (or not checked) image, sent to the API as {"type":"image", ...}.
type ImageResult struct {
	URL         string        `json:"url"`
	State       string        `json:"state"`
	Reason      string        `json:"reason,omitempty"`
	Status      *int          `json:"status"`
	FinalStatus *int          `json:"finalStatus"`
	FinalURL    string        `json:"finalUrl,omitempty"`
	Chain       []RedirectHop `json:"chain,omitempty"`
	ContentType string        `json:"contentType,omitempty"`
	Format      string        `json:"format,omitempty"`
	Bytes       *int64        `json:"bytes,omitempty"`
	SizeFrom    string        `json:"sizeFrom,omitempty"` // content-range | content-length | body
	Width       int           `json:"width,omitempty"`
	Height      int           `json:"height,omitempty"`
	ReadBytes   int           `json:"readBytes,omitempty"`
	Ms          int           `json:"ms"`
}

type robotsEntry struct {
	once sync.Once
	r    *robots
	err  string
}

type imageAuditor struct {
	job      Job
	ctx      context.Context
	cancel   context.CancelFunc
	ev       *emitter
	site     *httpClient
	ext      *httpClient
	thr      *throttle
	siteHost string
	stopWhy  atomic.Value
	robotsMu sync.Mutex
	robots   map[string]*robotsEntry

	total, done, ok, broken, failed, unverified, deferred atomic.Int64
}

func (a *imageAuditor) stop(reason string) {
	if s, _ := a.stopWhy.Load().(string); s == "" {
		a.stopWhy.Store(reason)
	}
	a.cancel()
}

func (a *imageAuditor) stopped() string {
	s, _ := a.stopWhy.Load().(string)
	return s
}

func newImageAuditor(ctx context.Context, cancel context.CancelFunc, job Job, ev *emitter) (*imageAuditor, error) {
	if err := job.normalize(); err != nil {
		return nil, err
	}
	if job.ImagesFile == "" {
		return nil, fmt.Errorf("imagesFile is required")
	}
	if job.ProbeBytes <= 0 {
		job.ProbeBytes = 64 << 10
	}
	if job.ProbeBytes > 512<<10 {
		job.ProbeBytes = 512 << 10
	}
	b, _ := url.Parse(job.BaseURL)
	a := &imageAuditor{job: job, ctx: ctx, cancel: cancel, ev: ev, siteHost: strings.ToLower(b.Host), robots: map[string]*robotsEntry{}}
	a.stopWhy.Store("")
	maxThrottle := time.Duration(job.MaxCrawlDelayMs) * time.Millisecond
	if maxThrottle < 30*time.Second {
		maxThrottle = 30 * time.Second
	}
	a.thr = newThrottle(time.Duration(job.RequestDelayMs)*time.Millisecond, maxThrottle)
	base := clientOpts{UserAgent: job.UserAgent, Timeout: time.Duration(job.TimeoutMs) * time.Millisecond, MaxBody: job.ProbeBytes, Retries: job.Retries,
		MaxRetryWait: time.Duration(job.MaxRetryWaitMs) * time.Millisecond, AllowLoopback: job.AllowLoopback, Concurrency: job.Concurrency}
	site := base
	site.Throttle = a.thr
	a.site = newHTTPClient(site)
	ext := base
	ext.PerHostDelay = 150 * time.Millisecond
	a.ext = newHTTPClient(ext)
	return a, nil
}

func (a *imageAuditor) client(u string) *httpClient {
	if isSameSite(u, a.siteHost) {
		return a.site
	}
	return a.ext
}

// robotsFor reads robots.txt of the image's host once per job. 4xx = no rules; 5xx or no answer = not readable (the
// host's images are then not checked, as a crawler must not assume it may fetch them).
func (a *imageAuditor) robotsFor(u *url.URL) (*robots, string) {
	key := strings.ToLower(u.Scheme + "://" + u.Host)
	a.robotsMu.Lock()
	e := a.robots[key]
	if e == nil {
		e = &robotsEntry{}
		a.robots[key] = e
	}
	a.robotsMu.Unlock()
	e.once.Do(func() {
		target := key + "/robots.txt"
		r := a.client(target).request(a.ctx, target, reqOpts{ReadBody: true, Accept: "text/plain,*/*;q=0.5", MaxBody: 512 << 10})
		switch {
		case r.FinalStatus != nil && *r.FinalStatus >= 200 && *r.FinalStatus < 300:
			e.r = parseRobots(string(r.Body))
			if isSameSite(target, a.siteHost) && a.job.RespectRobots {
				if _, _, cd := e.r.groupFor(a.job.UserAgent); cd > 0 {
					d := time.Duration(cd * float64(time.Second))
					if lim := time.Duration(a.job.MaxCrawlDelayMs) * time.Millisecond; d > lim {
						d = lim
					}
					a.thr.setFloor(d)
				}
			}
		case r.FinalStatus != nil && *r.FinalStatus >= 400 && *r.FinalStatus < 500 && *r.FinalStatus != 429:
			e.r = parseRobots("")
		case r.FinalStatus != nil:
			e.err = fmt.Sprintf("robots.txt of %s answered HTTP %d", u.Host, *r.FinalStatus)
		default:
			e.err = fmt.Sprintf("robots.txt of %s could not be read (%s)", u.Host, r.Error)
		}
	})
	return e.r, e.err
}

var contentRangeTotal = regexp.MustCompile(`/(\d+)\s*$`)

func (a *imageAuditor) check(raw string) ImageResult {
	t0 := time.Now()
	res := ImageResult{URL: raw}
	finish := func(state, reason string) ImageResult {
		res.State, res.Reason, res.Ms = state, reason, int(time.Since(t0).Milliseconds())
		return res
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return finish("unverified", "not an http(s) image URL")
	}
	if err := checkURL(raw, a.job.AllowLoopback); err != nil {
		return finish("unverified", err.Error())
	}
	if !isSameSite(raw, a.siteHost) && !imageCDN.MatchString(hostOf(raw)) && !firstPartyCDN.MatchString(hostOf(raw)) {
		return finish("unverified", "third-party host: not checked (only the website and its image CDN are requested)")
	}
	if a.job.RespectRobots {
		rb, rerr := a.robotsFor(u)
		if a.ctx.Err() != nil {
			return finish("deferred", "cancelled before the check")
		}
		if rerr != "" {
			return finish("unverified", rerr+" — its images are not requested")
		}
		pq := u.EscapedPath()
		if u.RawQuery != "" {
			pq += "?" + u.RawQuery
		}
		if ok, rule := rb.allowed(a.job.UserAgent, pq); !ok {
			msg := "disallowed by robots.txt for our user-agent"
			if rule != nil {
				msg += fmt.Sprintf(" (Disallow: %s)", rule.Path)
			}
			return finish("unverified", msg)
		}
	}
	cl := a.client(raw)
	g := cl.request(a.ctx, raw, reqOpts{Method: http.MethodGet, ReadBody: true, AnyContentType: true, MaxBody: a.job.ProbeBytes, Accept: imageAccept, Range: fmt.Sprintf("bytes=0-%d", a.job.ProbeBytes-1)})
	if a.ctx.Err() != nil && g.FinalStatus == nil {
		return finish("deferred", "cancelled during the check")
	}
	res.Status, res.FinalStatus, res.Chain, res.ContentType = g.Status, g.FinalStatus, g.Chain, g.ContentType
	if len(g.Chain) > 0 {
		res.FinalURL = g.FinalURL
	}
	if g.FinalStatus == nil {
		if g.RedirectLoop || g.TooManyRedirects {
			return finish("broken", g.Error)
		}
		return finish("failed", g.Error)
	}
	st := *g.FinalStatus
	if st == 416 {
		// Range not satisfiable (e.g. an empty file): ask for the headers only.
		h := cl.request(a.ctx, g.FinalURL, reqOpts{Method: http.MethodHead, Accept: imageAccept})
		if h.FinalStatus != nil {
			st = *h.FinalStatus
			res.FinalStatus, res.ContentType = h.FinalStatus, h.ContentType
			g.Headers, g.Body = h.Headers, nil
		}
	}
	switch {
	case st == 429 || st == 503:
		reason := fmt.Sprintf("rate limited (HTTP %d) after %d retries", st, a.job.Retries)
		if ra := g.Headers["retry-after"]; ra != "" {
			reason += ", Retry-After: " + ra
		}
		return finish("unverified", reason)
	case st >= 500:
		return finish("failed", fmt.Sprintf("HTTP %d", st))
	case st >= 400:
		return finish("broken", fmt.Sprintf("HTTP %d", st))
	case st >= 300:
		return finish("broken", fmt.Sprintf("HTTP %d without a usable Location header", st))
	}
	// Size: the total from Content-Range (206), else Content-Length, else what was read when the whole body fit.
	if m := contentRangeTotal.FindStringSubmatch(g.Headers["content-range"]); m != nil {
		if n, err := strconv.ParseInt(m[1], 10, 64); err == nil {
			res.Bytes, res.SizeFrom = &n, "content-range"
		}
	} else if n, err := strconv.ParseInt(g.Headers["content-length"], 10, 64); err == nil && st != 206 {
		res.Bytes, res.SizeFrom = &n, "content-length"
	} else if g.Body != nil && !g.Truncated && st == 200 {
		n := int64(len(g.Body))
		res.Bytes, res.SizeFrom = &n, "body"
	}
	res.ReadBytes = len(g.Body)
	format, w, h := sniffImage(g.Body, res.ContentType)
	res.Format, res.Width, res.Height = format, w, h
	ct := strings.ToLower(res.ContentType)
	isImage := strings.HasPrefix(ct, "image/") || (format != "" && format != "html")
	if !isImage {
		if ct == "" {
			return finish("broken", "the answer is not an image (no content type, unknown data)")
		}
		return finish("broken", "the answer is not an image ("+strings.SplitN(ct, ";", 2)[0]+")")
	}
	return finish("ok", "")
}

func (a *imageAuditor) progress() {
	a.ev.emit(map[string]any{"type": "progress", "total": a.total.Load(), "done": a.done.Load(), "ok": a.ok.Load(), "broken": a.broken.Load(), "failed": a.failed.Load(),
		"unverified": a.unverified.Load(), "deferred": a.deferred.Load(), "requests": a.site.done.Load() + a.ext.done.Load(),
		"rateLimited": a.site.rate429.Load() + a.ext.rate429.Load(), "retries": a.site.retries.Load() + a.ext.retries.Load()})
}

func (a *imageAuditor) record(r ImageResult) {
	switch r.State {
	case "ok":
		a.ok.Add(1)
	case "broken":
		a.broken.Add(1)
	case "failed":
		a.failed.Add(1)
	case "unverified":
		a.unverified.Add(1)
	default:
		a.deferred.Add(1)
	}
	a.done.Add(1)
	m := map[string]any{"type": "image", "result": r}
	a.ev.emit(m)
}

func (a *imageAuditor) run() int {
	f, err := os.Open(a.job.ImagesFile)
	if err != nil {
		a.ev.emit(map[string]any{"type": "done", "state": "failed", "reason": "cannot read the image list: " + err.Error()})
		return 1
	}
	var list []string
	seen := map[string]bool{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var u string
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var rec struct {
			URL string `json:"url"`
		}
		if err := jsonUnmarshal(line, &rec); err != nil || rec.URL == "" {
			continue
		}
		u = strings.SplitN(rec.URL, "#", 2)[0]
		if seen[u] { // each image is requested once per job
			continue
		}
		seen[u] = true
		list = append(list, u)
	}
	f.Close()
	a.total.Store(int64(len(list)))
	a.ev.emit(map[string]any{"type": "phase", "phase": "checking"})

	budget := time.Duration(a.job.ChecksBudgetMs) * time.Millisecond
	var deadline time.Time
	if budget > 0 {
		deadline = time.Now().Add(budget)
	}
	tick := time.NewTicker(time.Duration(a.job.ProgressMs) * time.Millisecond)
	stopTick := make(chan struct{})
	go func() {
		for {
			select {
			case <-tick.C:
				a.progress()
			case <-stopTick:
				return
			}
		}
	}()
	jobs := make(chan string)
	var wg sync.WaitGroup
	budgetHit := atomic.Bool{}
	for w := 0; w < a.job.Concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for u := range jobs {
				switch {
				case a.stopped() != "":
					a.record(ImageResult{URL: u, State: "deferred", Reason: "not checked: the Image Audit was cancelled"})
				case !deadline.IsZero() && time.Now().After(deadline):
					budgetHit.Store(true)
					a.record(ImageResult{URL: u, State: "deferred", Reason: fmt.Sprintf("not checked: the %d-minute time budget ran out", int(budget.Minutes()))})
				default:
					a.record(a.check(u))
				}
			}
		}()
	}
	for _, u := range list {
		jobs <- u
	}
	close(jobs)
	wg.Wait()
	tick.Stop()
	close(stopTick)
	a.progress()
	state, reason := "completed", ""
	switch {
	case a.stopped() != "":
		state, reason = "cancelled", "Cancelled; images not checked are reported as deferred."
	case budgetHit.Load():
		state, reason = "partial", "The time budget ran out; images not checked are reported as deferred."
	}
	a.ev.emit(map[string]any{"type": "done", "state": state, "reason": reason, "counts": map[string]int64{"total": a.total.Load(), "ok": a.ok.Load(), "broken": a.broken.Load(),
		"failed": a.failed.Load(), "unverified": a.unverified.Load(), "deferred": a.deferred.Load(), "requests": a.site.done.Load() + a.ext.done.Load()}})
	return 0
}

// ---------------------------------------------------------------------------------------------- format sniffing

var svgSize = regexp.MustCompile(`(?is)<svg\b[^>]*>`)
var svgAttr = regexp.MustCompile(`(?i)\b(width|height|viewBox)\s*=\s*["']([^"']+)["']`)

// sniffImage reads the format and pixel size from the first bytes of an image (PNG, GIF, JPEG, WebP, AVIF/HEIF, BMP,
// SVG). Unknown or cut-off data gives a format from the content type and no size.
func sniffImage(b []byte, contentType string) (format string, w, h int) {
	ct := strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	switch {
	case len(b) >= 24 && bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "png", int(binary.BigEndian.Uint32(b[16:20])), int(binary.BigEndian.Uint32(b[20:24]))
	case len(b) >= 10 && (bytes.HasPrefix(b, []byte("GIF87a")) || bytes.HasPrefix(b, []byte("GIF89a"))):
		return "gif", int(binary.LittleEndian.Uint16(b[6:8])), int(binary.LittleEndian.Uint16(b[8:10]))
	case len(b) >= 4 && b[0] == 0xFF && b[1] == 0xD8:
		w, h = jpegSize(b)
		return "jpeg", w, h
	case len(b) >= 16 && bytes.Equal(b[0:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		w, h = webpSize(b)
		return "webp", w, h
	case len(b) >= 12 && bytes.Equal(b[4:8], []byte("ftyp")):
		brand := string(b[8:12])
		f := "heif"
		if brand == "avif" || brand == "avis" {
			f = "avif"
		}
		if i := bytes.Index(b, []byte("ispe")); i >= 4 && i+16 <= len(b) {
			return f, int(binary.BigEndian.Uint32(b[i+8 : i+12])), int(binary.BigEndian.Uint32(b[i+12 : i+16]))
		}
		return f, 0, 0
	case len(b) >= 26 && b[0] == 'B' && b[1] == 'M':
		w := int(int32(binary.LittleEndian.Uint32(b[18:22])))
		h := int(int32(binary.LittleEndian.Uint32(b[22:26])))
		if h < 0 {
			h = -h
		}
		return "bmp", w, h
	}
	head := b
	if len(head) > 4096 {
		head = head[:4096]
	}
	if ct == "image/svg+xml" || bytes.Contains(bytes.ToLower(head), []byte("<svg")) {
		if tag := svgSize.Find(b); tag != nil {
			var vb []string
			for _, m := range svgAttr.FindAllSubmatch(tag, -1) {
				v := strings.TrimSpace(string(m[2]))
				switch strings.ToLower(string(m[1])) {
				case "width":
					w = leadingInt(v)
				case "height":
					h = leadingInt(v)
				case "viewbox":
					vb = strings.Fields(strings.ReplaceAll(v, ",", " "))
				}
			}
			if (w == 0 || h == 0) && len(vb) == 4 {
				if fw, err := strconv.ParseFloat(vb[2], 64); err == nil {
					w = int(fw)
				}
				if fh, err := strconv.ParseFloat(vb[3], 64); err == nil {
					h = int(fh)
				}
			}
		}
		return "svg", w, h
	}
	if bytes.Contains(bytes.ToLower(head), []byte("<html")) || bytes.Contains(bytes.ToLower(head), []byte("<!doctype html")) {
		return "html", 0, 0
	}
	if strings.HasPrefix(ct, "image/") {
		return strings.TrimPrefix(strings.TrimPrefix(ct, "image/"), "x-"), 0, 0
	}
	return "", 0, 0
}

func leadingInt(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// jpegSize walks the JPEG markers to the first SOF segment (within the bytes read).
func jpegSize(b []byte) (int, int) {
	i := 2
	for i+9 < len(b) {
		if b[i] != 0xFF {
			i++
			continue
		}
		m := b[i+1]
		switch {
		case m == 0xFF:
			i++
			continue
		case m == 0xD8 || m == 0x01 || (m >= 0xD0 && m <= 0xD7):
			i += 2
			continue
		}
		seg := int(binary.BigEndian.Uint16(b[i+2 : i+4]))
		if (m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) || (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF) {
			return int(binary.BigEndian.Uint16(b[i+7 : i+9])), int(binary.BigEndian.Uint16(b[i+5 : i+7]))
		}
		if seg < 2 {
			return 0, 0
		}
		i += 2 + seg
	}
	return 0, 0
}

func webpSize(b []byte) (int, int) {
	if len(b) < 30 {
		return 0, 0
	}
	switch string(b[12:16]) {
	case "VP8 ":
		return int(binary.LittleEndian.Uint16(b[26:28]) & 0x3fff), int(binary.LittleEndian.Uint16(b[28:30]) & 0x3fff)
	case "VP8L":
		b0, b1, b2, b3 := int(b[21]), int(b[22]), int(b[23]), int(b[24])
		return 1 + (((b1 & 0x3F) << 8) | b0), 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
	case "VP8X":
		return 1 + int(uint32(b[24])|uint32(b[25])<<8|uint32(b[26])<<16), 1 + int(uint32(b[27])|uint32(b[28])<<8|uint32(b[29])<<16)
	}
	return 0, 0
}
