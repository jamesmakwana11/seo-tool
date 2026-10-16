import { describe, expect, it } from 'vitest';
import { diffLines, formatCss, formatHtml, formatJs } from '../../src/lib/diff';

describe('line diff and formatters', () => {
  it('finds moved and inserted lines with context', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const b = ['a', 'b', 'X', 'c', 'd', 'e', 'f', 'g', 'h', 'j', 'Y'].join('\n');
    const d = diffLines(a, b, { context: 1 });
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.lines.filter((l) => l.op !== ' ' && l.op !== '…').map((l) => `${l.op}${l.text}`)).toEqual(['+X', '-i', '+Y']);
    expect(d.lines.some((l) => l.op === '…')).toBe(true);
    expect(diffLines(a, a).lines.every((l) => l.op === ' ' || l.op === '…')).toBe(true);
  });

  it('stays bounded on large inputs (20,000 lines, a few changes)', () => {
    const big = Array.from({ length: 20000 }, (_, i) => `<div class="row-${i}">item ${i}</div>`);
    const changed = [...big];
    changed[5000] = '<div class="row-5000">CHANGED</div>';
    changed.splice(12000, 0, '<p>inserted</p>');
    const t0 = Date.now();
    const d = diffLines(big.join('\n'), changed.join('\n'));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect([d.added, d.removed]).toEqual([2, 1]);
    expect(d.coarse).toBe(false);
  });

  it('formats rendered HTML one element per line, hiding script bodies and nonces', () => {
    const f = formatHtml('<html><head><script nonce="abc123">var t = Date.now();</script><title>Shop</title></head><body><h1 class="t">Hi</h1></body></html>');
    expect(f).toContain('<title>');
    expect(f).toContain('Shop');
    expect(f).not.toContain('abc123');
    expect(f).not.toContain('Date.now');
    expect(f).toMatch(/<script>\[\d+ chars, #[0-9a-f]{8}\]<\/script>/);
    expect(f.split('\n').find((l) => l.includes('<h1'))).toMatch(/^ {4}<h1 class="t">$/);
  });

  it('re-flows minified CSS and JS so changes show up line by line', () => {
    expect(formatCss('a{color:red;margin:0}b{x:1}').split('\n')).toEqual(['a {', '  color:red;', '  margin:0}', 'b {', '  x:1}']);
    const js = formatJs('function a(){return 1};var b=2;if(b){a()}');
    expect(js.split('\n').length).toBeGreaterThan(3);
  });
});
