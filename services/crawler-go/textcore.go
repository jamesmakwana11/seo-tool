package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Client for the Rust text core (sentinel-textcore), one long-lived process per crawl.
//
// Frame protocol v1 on its stdin (little-endian): u8 kind, u32 payload length, payload.
//
//	kind 1 PAGE   : u32 id, u8 template, u8 flags (bit0 = ok page), then u32-length-prefixed UTF-8 strings
//	                title, meta, h1, description, then u32 block count and the blocks (the page's own text blocks)
//	kind 2 FINISH : empty — the core writes text.json in the work directory, prints "DONE text.json" and exits
//
// It prints "SENTINEL-TEXTCORE 1" when ready. Pages go through a bounded channel: if the core falls behind, crawling
// workers wait (back-pressure) instead of buffering page text without limit.

var templateCode = map[string]byte{"home": 0, "collection": 1, "product": 2, "blog_article": 3, "blog_index": 4, "page": 5, "search": 6, "other": 7}

type textPage struct {
	id          int32
	template    string
	ok          bool
	title, meta string
	h1, desc    string
	blocks      []string
}

type textCore struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	w      *bufio.Writer
	ch     chan textPage
	done   chan struct{}
	failed error
	mu     sync.Mutex
	stderr strings.Builder
	sent   int
	pid    int
	stdout *bufio.Reader
}

func startTextCore(conf TextCoreConf, workDir string) (*textCore, error) {
	if conf.Disabled {
		return nil, errors.New("text core disabled")
	}
	bin := conf.Bin
	if bin == "" {
		return nil, errors.New("text core binary not configured")
	}
	if _, err := os.Stat(bin); err != nil {
		return nil, fmt.Errorf("text core binary not found at %s", bin)
	}
	cmd := exec.Command(bin, "--workdir", workDir, "--brand", conf.Brand)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	t := &textCore{cmd: cmd, stdin: stdin, w: bufio.NewWriterSize(stdin, 256<<10), ch: make(chan textPage, 64), done: make(chan struct{})}
	cmd.Stderr = &lockedBuilder{t: t}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	t.pid = cmd.Process.Pid
	t.stdout = bufio.NewReader(out)
	ready := make(chan error, 1)
	go func() {
		l, err := t.stdout.ReadString('\n')
		if err != nil {
			ready <- fmt.Errorf("text core did not start: %v %s", err, t.stderrText())
			return
		}
		if !strings.HasPrefix(l, "SENTINEL-TEXTCORE 1") {
			ready <- fmt.Errorf("text core speaks an unknown protocol: %q", strings.TrimSpace(l))
			return
		}
		ready <- nil
	}()
	select {
	case err := <-ready:
		if err != nil {
			cmd.Process.Kill()
			return nil, err
		}
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		return nil, errors.New("text core did not start within 10 s")
	}
	go t.loop()
	return t, nil
}

type lockedBuilder struct{ t *textCore }

func (l *lockedBuilder) Write(p []byte) (int, error) {
	l.t.mu.Lock()
	defer l.t.mu.Unlock()
	if l.t.stderr.Len() < 8192 {
		l.t.stderr.Write(p)
	}
	return len(p), nil
}

func (t *textCore) stderrText() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(t.stderr.String())
}

func putStr(b []byte, s string) []byte {
	var n [4]byte
	binary.LittleEndian.PutUint32(n[:], uint32(len(s)))
	b = append(b, n[:]...)
	return append(b, s...)
}

func (t *textCore) loop() {
	defer close(t.done)
	var buf []byte
	for p := range t.ch {
		if t.failed != nil {
			continue
		}
		buf = buf[:0]
		var n [4]byte
		binary.LittleEndian.PutUint32(n[:], uint32(p.id))
		buf = append(buf, n[:]...)
		buf = append(buf, templateCode[p.template])
		var flags byte
		if p.ok {
			flags |= 1
		}
		buf = append(buf, flags)
		buf = putStr(buf, p.title)
		buf = putStr(buf, p.meta)
		buf = putStr(buf, p.h1)
		buf = putStr(buf, p.desc)
		binary.LittleEndian.PutUint32(n[:], uint32(len(p.blocks)))
		buf = append(buf, n[:]...)
		for _, b := range p.blocks {
			buf = putStr(buf, b)
		}
		if err := t.frame(1, buf); err != nil {
			t.failed = fmt.Errorf("text core stopped accepting pages: %v %s", err, t.stderrText())
			continue
		}
		t.sent++
	}
}

func (t *textCore) frame(kind byte, payload []byte) error {
	var h [5]byte
	h[0] = kind
	binary.LittleEndian.PutUint32(h[1:], uint32(len(payload)))
	if _, err := t.w.Write(h[:]); err != nil {
		return err
	}
	_, err := t.w.Write(payload)
	return err
}

func (t *textCore) send(p textPage) { t.ch <- p }

// finish flushes, asks for the results and waits (bounded) for text.json.
func (t *textCore) finish(timeout time.Duration) error {
	close(t.ch)
	<-t.done
	if t.failed != nil {
		t.cmd.Process.Kill()
		t.cmd.Wait()
		return t.failed
	}
	if err := t.frame(2, nil); err != nil {
		t.cmd.Process.Kill()
		t.cmd.Wait()
		return err
	}
	if err := t.w.Flush(); err != nil {
		t.cmd.Process.Kill()
		t.cmd.Wait()
		return err
	}
	t.stdin.Close()
	res := make(chan error, 1)
	go func() {
		l, err := t.stdout.ReadString('\n')
		if err != nil {
			res <- fmt.Errorf("text core ended without a result: %v %s", err, t.stderrText())
			return
		}
		if !strings.HasPrefix(l, "DONE") {
			res <- fmt.Errorf("text core: %s", strings.TrimSpace(l))
			return
		}
		res <- nil
	}()
	var err error
	select {
	case err = <-res:
	case <-time.After(timeout):
		err = fmt.Errorf("text core did not finish within %s", timeout)
		t.cmd.Process.Kill()
	}
	werr := t.cmd.Wait()
	if err == nil && werr != nil {
		err = fmt.Errorf("text core exited with %v %s", werr, t.stderrText())
	}
	return err
}

func (t *textCore) kill() {
	if t == nil || t.cmd.Process == nil {
		return
	}
	t.cmd.Process.Kill()
	t.cmd.Wait()
}
