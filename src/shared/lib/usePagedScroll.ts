import { useState, type UIEvent } from "react";

// usePagedScroll — reveal a long list in pages, growing by `page` whenever the container is
// scrolled near its end (large catalogs like OpenRouter are 300+ rows). `setShown` is exposed
// for callers that reset paging (new data) or pre-page to a selection.
export function usePagedScroll(total: number, page = 40) {
  const [shown, setShown] = useState(page);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 32) {
      setShown((n) => (n < total ? n + page : n));
    }
  };
  return { shown, setShown, onScroll };
}
