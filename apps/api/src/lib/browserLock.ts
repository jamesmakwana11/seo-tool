/**
 * One browser at a time for the whole API process (Lighthouse audits, rendered checks and page captures across every
 * website): a Chromium needs 250–400 MB, so two at once would not fit a small server next to a crawl.
 */
let tail: Promise<unknown> = Promise.resolve();
let holder: string | undefined;

export function withBrowser<T>(who: string, fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    holder = who;
    try { return await fn(); } finally { holder = undefined; }
  };
  const p = tail.then(run, run);
  tail = p.catch(() => undefined);
  return p;
}

/** What is using the browser right now, if anything. */
export const browserHolder = () => holder;
