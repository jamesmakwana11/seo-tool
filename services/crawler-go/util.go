package main

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// gzWriter writes newline-delimited JSON records to a gzip file (safe for concurrent use).
type gzWriter struct {
	mu    sync.Mutex
	f     *os.File
	gz    *gzip.Writer
	bw    *bufio.Writer
	count int
	err   error
}

func newGzWriter(path string) (*gzWriter, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	gz, _ := gzip.NewWriterLevel(f, gzip.BestSpeed)
	return &gzWriter{f: f, gz: gz, bw: bufio.NewWriterSize(gz, 256<<10)}, nil
}

func (w *gzWriter) write(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return
	}
	if _, err := w.bw.Write(b); err != nil {
		w.err = err
		return
	}
	w.bw.WriteByte('\n')
	w.count++
}

func (w *gzWriter) close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.bw.Flush(); err != nil && w.err == nil {
		w.err = err
	}
	if err := w.gz.Close(); err != nil && w.err == nil {
		w.err = err
	}
	if err := w.f.Close(); err != nil && w.err == nil {
		w.err = err
	}
	return w.err
}

// rssMB: resident memory of a process in MB (Linux /proc). Elsewhere, for this process, the Go runtime's own view.
func rssMB(pid int) float64 {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/statm")
	if err == nil {
		f := strings.Fields(string(b))
		if len(f) >= 2 {
			pages, _ := strconv.ParseFloat(f[1], 64)
			return pages * float64(os.Getpagesize()) / 1048576
		}
	}
	if pid == os.Getpid() {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		return float64(m.Sys) / 1048576
	}
	return -1
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }
