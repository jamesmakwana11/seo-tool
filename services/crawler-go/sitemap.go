package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Sitemaps are parsed while they download (encoding/xml token stream), so a 50 MB / 50,000-URL file never sits in
// memory as a whole. Sitemap index files are followed breadth-first up to MaxSitemapFiles; .xml.gz files are unzipped.

type SitemapFile struct {
	URL       string `json:"url"`
	Status    *int   `json:"status"`
	Kind      string `json:"kind"` // urlset | sitemapindex | invalid | unreachable
	Count     int    `json:"count"`
	Error     string `json:"error,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	Ms        int    `json:"ms"`
}

type SitemapEntry struct {
	URL     string `json:"url"`
	Lastmod string `json:"lastmod,omitempty"`
	File    string `json:"file"`
}

type limitedReader struct {
	r     io.Reader
	left  int64
	trunc bool
}

func (l *limitedReader) Read(p []byte) (int, error) {
	if l.left <= 0 {
		l.trunc = true
		return 0, io.EOF
	}
	if int64(len(p)) > l.left {
		p = p[:l.left]
	}
	n, err := l.r.Read(p)
	l.left -= int64(n)
	return n, err
}

// stream opens target (redirects followed manually and re-checked, transient failures retried) and hands the final
// 200 response body to fn. Returns the final status (nil when there was no response) and an error message.
func (h *httpClient) stream(parent context.Context, target, accept string, fn func(io.Reader) error) (*int, string) {
	// A large file may need several request timeouts to download, but never hangs forever.
	limit := 10 * h.o.Timeout
	if limit < 2*time.Minute {
		limit = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(parent, limit)
	defer cancel()
	cur := target
	for hop := 0; hop <= h.o.MaxRedirects; hop++ {
		var res *http.Response
		var errMsg string
		for n := 0; ; n++ {
			res, errMsg = h.openOnce(ctx, cur, accept)
			status := 0
			if res != nil {
				status = res.StatusCode
			}
			ra, hasRA := time.Duration(0), false
			if res != nil {
				ra, hasRA = retryAfter(res.Header.Get("Retry-After"), time.Now())
			}
			if h.o.Throttle != nil {
				if status == 429 || status == 503 {
					h.o.Throttle.slowDown(ra)
				} else if status != 0 && status < 500 {
					h.o.Throttle.relax()
				}
			}
			transient := (status != 0 && retryStatus[status]) || (status == 0 && errMsg != "" && !noRetryErr.MatchString(errMsg))
			if !transient || n >= h.o.Retries || ctx.Err() != nil {
				break
			}
			wait := time.Duration(1000*(1<<n)) * time.Millisecond
			if hasRA {
				wait = ra
			}
			if res != nil {
				res.Body.Close()
			}
			if wait > h.o.MaxRetryWait {
				return intp(status), fmt.Sprintf("HTTP %d (asked to wait %s)", status, wait)
			}
			h.retries.Add(1)
			select {
			case <-ctx.Done():
				return nil, "cancelled"
			case <-time.After(wait):
			}
		}
		if res == nil {
			return nil, errMsg
		}
		loc := res.Header.Get("Location")
		if res.StatusCode >= 300 && res.StatusCode < 400 && loc != "" {
			res.Body.Close()
			next, ok := resolveURL(loc, cur)
			if !ok {
				return intp(res.StatusCode), "invalid Location header: " + loc
			}
			cur = next
			continue
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return intp(res.StatusCode), fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		if err := fn(res.Body); err != nil {
			return intp(200), err.Error()
		}
		return intp(200), ""
	}
	return nil, fmt.Sprintf("more than %d redirects", h.o.MaxRedirects)
}

func (h *httpClient) openOnce(ctx context.Context, target, accept string) (*http.Response, string) {
	if err := checkURL(target, h.o.AllowLoopback); err != nil {
		return nil, err.Error()
	}
	if h.o.Throttle != nil {
		if err := h.o.Throttle.wait(ctx); err != nil {
			return nil, "cancelled"
		}
	}
	// The whole download (not just the headers) may take several timeouts for a large file.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err.Error()
	}
	req.Header.Set("User-Agent", h.o.UserAgent)
	req.Header.Set("Accept", accept)
	res, err := h.c.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "cancelled"
		}
		return nil, describeErr(err, false, h.o.Timeout)
	}
	return res, ""
}

type sitemapParse struct {
	kind     string
	urls     int
	children []string
	trunc    bool
}

// parseSitemapStream reads <urlset> / <sitemapindex> documents token by token. Only a <loc> that is a direct child of
// <url> / <sitemap> counts (image:loc, video:loc … are ignored).
func parseSitemapStream(r io.Reader, maxBytes int64, onURL func(loc, lastmod string)) (*sitemapParse, error) {
	br := bufio.NewReaderSize(r, 64<<10)
	var src io.Reader = br
	if head, err := br.Peek(2); err == nil && head[0] == 0x1f && head[1] == 0x8b {
		zr, err := gzip.NewReader(br)
		if err != nil {
			return nil, fmt.Errorf("could not decompress gzip sitemap: %v", err)
		}
		defer zr.Close()
		src = zr
	}
	lr := &limitedReader{r: src, left: maxBytes}
	dec := xml.NewDecoder(lr)
	dec.Strict = false
	dec.CharsetReader = func(_ string, in io.Reader) (io.Reader, error) { return in, nil }
	out := &sitemapParse{}
	depth := 0
	itemDepth := -1 // depth of the current <url> / <sitemap>
	var field string
	var loc, lastmod strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			if lr.trunc {
				break
			}
			if out.kind == "" {
				return nil, errors.New("not XML")
			}
			break // keep what was read before the malformed part
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			name := strings.ToLower(t.Name.Local)
			if out.kind == "" {
				switch name {
				case "urlset":
					out.kind = "urlset"
				case "sitemapindex":
					out.kind = "sitemapindex"
				default:
					return nil, errors.New("no <urlset> or <sitemapindex> root element")
				}
				continue
			}
			if itemDepth < 0 && ((out.kind == "urlset" && name == "url") || (out.kind == "sitemapindex" && name == "sitemap")) && depth == 2 {
				itemDepth = depth
				loc.Reset()
				lastmod.Reset()
				continue
			}
			if itemDepth > 0 && depth == itemDepth+1 && (t.Name.Space == "" || !strings.Contains(strings.ToLower(t.Name.Space), "image") && !strings.Contains(strings.ToLower(t.Name.Space), "video") && !strings.Contains(strings.ToLower(t.Name.Space), "news")) {
				if name == "loc" || name == "lastmod" {
					field = name
				}
			}
		case xml.CharData:
			switch field {
			case "loc":
				loc.Write(t)
			case "lastmod":
				lastmod.Write(t)
			}
		case xml.EndElement:
			if field != "" && depth == itemDepth+1 {
				field = ""
			}
			if depth == itemDepth {
				l := strings.TrimSpace(loc.String())
				if l != "" {
					if out.kind == "urlset" {
						out.urls++
						onURL(l, strings.TrimSpace(lastmod.String()))
					} else {
						out.children = append(out.children, l)
					}
				}
				itemDepth = -1
			}
			depth--
		}
	}
	if out.kind == "" {
		if lr.trunc {
			return nil, errors.New("not XML")
		}
		return nil, errors.New("no <urlset> or <sitemapindex> root element")
	}
	out.trunc = lr.trunc
	return out, nil
}

type sitemapResult struct {
	Files      []SitemapFile `json:"files"`
	RootURLs   []string      `json:"rootUrls"`
	Entries    int           `json:"entries"`
	Ms         int           `json:"ms"`
	SameSite   int           `json:"sameSiteEntries"`
	OtherHosts int           `json:"otherHostEntries"`
}

// fetchSitemaps reads every sitemap breadth-first. onEntry is called for each <url> (from several goroutines, serialised
// here by a mutex), so entries go straight to the frontier and the entries file instead of a list in memory.
func fetchSitemaps(ctx context.Context, h *httpClient, roots []string, maxFiles int, maxBytes int64, concurrency int, onEntry func(SitemapEntry), onFile func(SitemapFile)) sitemapResult {
	t0 := time.Now()
	res := sitemapResult{RootURLs: roots, Files: []SitemapFile{}}
	seen := map[string]bool{}
	level := []string{}
	for _, r := range roots {
		if !seen[r] {
			seen[r] = true
			level = append(level, r)
		}
	}
	var mu sync.Mutex
	if concurrency < 1 {
		concurrency = 1
	}
	for len(level) > 0 && len(res.Files) < maxFiles && ctx.Err() == nil {
		if room := maxFiles - len(res.Files); len(level) > room {
			level = level[:room]
		}
		files := make([]SitemapFile, len(level))
		children := make([][]string, len(level))
		sem := make(chan struct{}, concurrency)
		var wg sync.WaitGroup
		for i, u := range level {
			wg.Add(1)
			sem <- struct{}{}
			go func(i int, u string) {
				defer wg.Done()
				defer func() { <-sem }()
				f0 := time.Now()
				var parsed *sitemapParse
				var perr error
				status, errMsg := h.stream(ctx, u, "application/xml,text/xml;q=0.9,*/*;q=0.5", func(body io.Reader) error {
					parsed, perr = parseSitemapStream(body, maxBytes, func(loc, lastmod string) {
						mu.Lock()
						onEntry(SitemapEntry{URL: loc, Lastmod: lastmod, File: u})
						mu.Unlock()
					})
					return nil
				})
				f := SitemapFile{URL: u, Status: status, Ms: int(time.Since(f0).Milliseconds())}
				switch {
				case status == nil || *status != 200:
					f.Kind = "unreachable"
					f.Error = errMsg
					if f.Error == "" && status != nil {
						f.Error = fmt.Sprintf("HTTP %d", *status)
					}
				case perr != nil:
					f.Kind = "invalid"
					f.Error = perr.Error()
				default:
					f.Kind = parsed.kind
					if parsed.kind == "urlset" {
						f.Count = parsed.urls
					} else {
						f.Count = len(parsed.children)
						children[i] = parsed.children
					}
					if parsed.trunc {
						f.Truncated = true
						f.Error = fmt.Sprintf("larger than %d MB: only the first %d MB were read", maxBytes>>20, maxBytes>>20)
					}
				}
				files[i] = f
			}(i, u)
		}
		wg.Wait()
		next := []string{}
		for i := range level {
			res.Files = append(res.Files, files[i])
			if onFile != nil {
				onFile(files[i])
			}
			for _, c := range children[i] {
				if !seen[c] {
					seen[c] = true
					next = append(next, c)
				}
			}
		}
		level = next
	}
	res.Ms = int(time.Since(t0).Milliseconds())
	return res
}
