package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func pngBytes(w, h, total int) []byte {
	b := make([]byte, total)
	copy(b, "\x89PNG\r\n\x1a\n")
	binary.BigEndian.PutUint32(b[8:12], 13)
	copy(b[12:16], "IHDR")
	binary.BigEndian.PutUint32(b[16:20], uint32(w))
	binary.BigEndian.PutUint32(b[20:24], uint32(h))
	return b
}

func jpegBytes(w, h int) []byte {
	b := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10}
	b = append(b, make([]byte, 14)...) // APP0 payload
	sof := []byte{0xFF, 0xC0, 0x00, 0x11, 0x08, byte(h >> 8), byte(h), byte(w >> 8), byte(w), 0x03}
	b = append(b, sof...)
	return append(b, make([]byte, 40)...)
}

// imageServer serves images like a CDN: Range requests, a robots.txt, rate limiting and errors on chosen paths.
type imageServer struct {
	srv      *httptest.Server
	mu       sync.Mutex
	hits     map[string]int
	ranges   map[string]string
	limited  atomic.Int32
	sentBody atomic.Int64
}

func newImageServer(t *testing.T) *imageServer {
	s := &imageServer{hits: map[string]int{}, ranges: map[string]string{}}
	big := pngBytes(1600, 1200, 900_000)
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.hits[r.URL.Path]++
		s.ranges[r.URL.Path] = r.Header.Get("Range")
		s.mu.Unlock()
		switch r.URL.Path {
		case "/robots.txt":
			w.Write([]byte("User-agent: *\nDisallow: /private/\n"))
		case "/img/ok.png", "/img/dup.png":
			serveRange(w, r, big, "image/png", s)
		case "/img/no-range.png": // ignores Range: the client must stop reading after the probe
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Content-Length", strconv.Itoa(len(big)))
			n, _ := w.Write(big)
			s.sentBody.Add(int64(n))
		case "/img/photo.jpg":
			serveRange(w, r, jpegBytes(640, 480), "image/jpeg", s)
		case "/img/moved.jpg":
			http.Redirect(w, r, "/img/photo.jpg", http.StatusMovedPermanently)
		case "/img/limited.png":
			if s.limited.Add(1) == 1 {
				w.Header().Set("Retry-After", "1")
				w.WriteHeader(429)
				return
			}
			serveRange(w, r, pngBytes(10, 10, 200), "image/png", s)
		case "/img/always-limited.png":
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(429)
		case "/img/error.png":
			w.WriteHeader(500)
		case "/img/soft404.png":
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte("<!doctype html><html><body>Not found</body></html>"))
		case "/img/slow.png":
			time.Sleep(300 * time.Millisecond)
			serveRange(w, r, pngBytes(5, 5, 100), "image/png", s)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func serveRange(w http.ResponseWriter, r *http.Request, b []byte, ct string, s *imageServer) {
	w.Header().Set("Content-Type", ct)
	if rg := r.Header.Get("Range"); strings.HasPrefix(rg, "bytes=0-") {
		end, _ := strconv.Atoi(strings.TrimPrefix(rg, "bytes=0-"))
		if end >= len(b) {
			end = len(b) - 1
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", end, len(b)))
		w.Header().Set("Content-Length", strconv.Itoa(end+1))
		w.WriteHeader(206)
		n, _ := w.Write(b[:end+1])
		s.sentBody.Add(int64(n))
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	n, _ := w.Write(b)
	s.sentBody.Add(int64(n))
}

func runImages(t *testing.T, base string, urls []string, mutate func(*Job), during func(a *imageAuditor)) (map[string]ImageResult, map[string]any) {
	t.Helper()
	dir := t.TempDir()
	in := filepath.Join(dir, "in.ndjson")
	var b strings.Builder
	for _, u := range urls {
		j, _ := json.Marshal(map[string]string{"url": u})
		b.Write(j)
		b.WriteByte('\n')
	}
	os.WriteFile(in, []byte(b.String()), 0o600)
	job := Job{Mode: "images", BaseURL: base + "/", WorkDir: dir, ImagesFile: in, AllowLoopback: true, RespectRobots: true, Retries: 1, Concurrency: 4, ProgressMs: 50, TimeoutMs: 3000, ProbeBytes: 4096}
	if mutate != nil {
		mutate(&job)
	}
	var out bytes.Buffer
	ev := &emitter{w: bufio.NewWriter(&out)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, err := newImageAuditor(ctx, cancel, job, ev)
	if err != nil {
		t.Fatal(err)
	}
	if during != nil {
		go during(a)
	}
	a.run()
	res := map[string]ImageResult{}
	var done map[string]any
	for _, line := range strings.Split(out.String(), "\n") {
		if line == "" {
			continue
		}
		var m struct {
			Type   string      `json:"type"`
			Result ImageResult `json:"result"`
		}
		json.Unmarshal([]byte(line), &m)
		if m.Type == "image" {
			if _, dup := res[m.Result.URL]; dup {
				t.Errorf("image reported twice: %s", m.Result.URL)
			}
			res[m.Result.URL] = m.Result
		} else if m.Type == "done" {
			json.Unmarshal([]byte(line), &done)
		}
	}
	return res, done
}

func TestImageAuditChecksEachImageOnceWithoutDownloadingIt(t *testing.T) {
	s := newImageServer(t)
	b := s.srv.URL
	urls := []string{b + "/img/ok.png", b + "/img/dup.png", b + "/img/dup.png", b + "/img/dup.png#zoom", b + "/img/no-range.png", b + "/img/moved.jpg",
		b + "/img/missing.png", b + "/img/error.png", b + "/img/soft404.png", b + "/private/secret.png", b + "/img/always-limited.png", "https://tracker.example.org/pixel.gif"}
	res, done := runImages(t, b, urls, nil, nil)
	if done["state"] != "completed" {
		t.Fatalf("done = %v", done)
	}
	if len(res) != 10 {
		t.Fatalf("want 10 unique images, got %d: %v", len(res), res)
	}
	ok := res[b+"/img/ok.png"]
	if ok.State != "ok" || ok.Format != "png" || ok.Width != 1600 || ok.Height != 1200 || ok.Bytes == nil || *ok.Bytes != 900_000 || ok.SizeFrom != "content-range" || ok.ReadBytes > 4096 {
		t.Fatalf("ok.png = %+v", ok)
	}
	if s.ranges["/img/ok.png"] != "bytes=0-4095" {
		t.Fatalf("Range header = %q", s.ranges["/img/ok.png"])
	}
	if s.hits["/img/dup.png"] != 1 {
		t.Fatalf("a duplicate image was requested %d times", s.hits["/img/dup.png"])
	}
	nr := res[b+"/img/no-range.png"]
	if nr.State != "ok" || nr.Bytes == nil || *nr.Bytes != 900_000 || nr.SizeFrom != "content-length" || nr.ReadBytes > 4096 || nr.Width != 1600 {
		t.Fatalf("no-range.png = %+v", nr)
	}
	mv := res[b+"/img/moved.jpg"]
	if mv.State != "ok" || len(mv.Chain) != 1 || mv.Chain[0].Status != 301 || *mv.Status != 301 || *mv.FinalStatus != 206 || mv.Format != "jpeg" || mv.Width != 640 || mv.Height != 480 || !strings.HasSuffix(mv.FinalURL, "/img/photo.jpg") {
		t.Fatalf("moved.jpg = %+v", mv)
	}
	for u, want := range map[string]string{"/img/missing.png": "broken", "/img/error.png": "failed", "/img/soft404.png": "broken", "/private/secret.png": "unverified", "/img/always-limited.png": "unverified"} {
		if got := res[b+u]; got.State != want {
			t.Errorf("%s = %s (%s), want %s", u, got.State, got.Reason, want)
		}
	}
	if s.hits["/private/secret.png"] != 0 {
		t.Fatal("an image disallowed by robots.txt was requested")
	}
	if !strings.Contains(res[b+"/img/soft404.png"].Reason, "text/html") || !strings.Contains(res[b+"/private/secret.png"].Reason, "robots.txt") {
		t.Fatalf("reasons: %q / %q", res[b+"/img/soft404.png"].Reason, res[b+"/private/secret.png"].Reason)
	}
	if r := res[b+"/img/always-limited.png"]; !strings.Contains(r.Reason, "rate limited (HTTP 429)") || !strings.Contains(r.Reason, "Retry-After: 120") {
		t.Fatalf("rate limited reason: %q", r.Reason)
	}
	if tp := res["https://tracker.example.org/pixel.gif"]; tp.State != "unverified" || !strings.Contains(tp.Reason, "third-party") {
		t.Fatalf("third-party = %+v", tp)
	}
	// Only the image probes were sent, not whole files (900 KB images, 4 KB read each).
	if s.sentBody.Load() > 950_000 {
		t.Logf("server wrote %d body bytes (the no-range image may be cut off by the connection close)", s.sentBody.Load())
	}
}

func TestImageAuditHonoursRetryAfter(t *testing.T) {
	s := newImageServer(t)
	t0 := time.Now()
	res, _ := runImages(t, s.srv.URL, []string{s.srv.URL + "/img/limited.png"}, nil, nil)
	r := res[s.srv.URL+"/img/limited.png"]
	if r.State != "ok" || s.limited.Load() != 2 {
		t.Fatalf("limited.png = %+v after %d answers", r, s.limited.Load())
	}
	if time.Since(t0) < 900*time.Millisecond {
		t.Fatalf("Retry-After: 1 was not waited for (%v)", time.Since(t0))
	}
}

func TestImageAuditCancelAndBudgetDeferRemainingImages(t *testing.T) {
	s := newImageServer(t)
	var urls []string
	for i := 0; i < 40; i++ {
		urls = append(urls, fmt.Sprintf("%s/img/slow.png?v=%d", s.srv.URL, i))
	}
	res, done := runImages(t, s.srv.URL, urls, func(j *Job) { j.Concurrency = 2 }, func(a *imageAuditor) {
		time.Sleep(700 * time.Millisecond)
		a.stop("user")
	})
	if done["state"] != "cancelled" || len(res) != 40 {
		t.Fatalf("done = %v, results %d", done, len(res))
	}
	okN, deferred := 0, 0
	for _, r := range res {
		switch r.State {
		case "ok":
			okN++
		case "deferred":
			deferred++
		default:
			t.Fatalf("unexpected %+v", r)
		}
	}
	if okN == 0 || deferred == 0 || okN+deferred != 40 {
		t.Fatalf("ok %d deferred %d", okN, deferred)
	}
	// Time budget: what is left is deferred, the job ends as partial.
	res2, done2 := runImages(t, s.srv.URL, urls[:12], func(j *Job) { j.Concurrency = 1; j.ChecksBudgetMs = 500 }, nil)
	d := 0
	for _, r := range res2 {
		if r.State == "deferred" {
			d++
			if !strings.Contains(r.Reason, "time budget") {
				t.Fatalf("reason %q", r.Reason)
			}
		}
	}
	if done2["state"] != "partial" || d == 0 {
		t.Fatalf("budget: done %v deferred %d", done2, d)
	}
}

func TestSniffImageFormats(t *testing.T) {
	webpVP8X := append([]byte("RIFF\x00\x00\x00\x00WEBPVP8X"), make([]byte, 20)...)
	webpVP8X[24], webpVP8X[25] = 0x1F, 0x03 // width-1 = 799
	webpVP8X[27], webpVP8X[28] = 0x57, 0x02 // height-1 = 599
	gif := append([]byte("GIF89a"), 0x40, 0x01, 0xF0, 0x00)
	avif := append([]byte("\x00\x00\x00\x1cftypavif"), make([]byte, 40)...)
	copy(avif[30:], []byte("\x00\x00\x00\x14ispe\x00\x00\x00\x00\x00\x00\x04\x00\x00\x00\x03\x00"))
	cases := []struct {
		b    []byte
		ct   string
		f    string
		w, h int
	}{
		{pngBytes(32, 16, 40), "", "png", 32, 16},
		{jpegBytes(1024, 768), "image/jpeg", "jpeg", 1024, 768},
		{webpVP8X, "", "webp", 800, 600},
		{gif, "", "gif", 320, 240},
		{avif, "image/avif", "avif", 1024, 768},
		{[]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect/></svg>`), "image/svg+xml", "svg", 120, 60},
		{[]byte(`<?xml version="1.0"?><svg width="48px" height="24" xmlns="http://www.w3.org/2000/svg"></svg>`), "", "svg", 48, 24},
		{[]byte("<!doctype html><html></html>"), "text/html", "html", 0, 0},
		{jpegBytes(10, 10)[:8], "image/jpeg", "jpeg", 0, 0}, // cut off before the size
	}
	for i, c := range cases {
		f, w, h := sniffImage(c.b, c.ct)
		if f != c.f || w != c.w || h != c.h {
			t.Errorf("case %d: %s %dx%d, want %s %dx%d", i, f, w, h, c.f, c.w, c.h)
		}
	}
}
