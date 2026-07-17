import { useState } from "react";

// Copy-to-clipboard with the shared 1.4s "Copied" flash.
export function useCopyButton(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {}
    );
  };
  return { copied, copy };
}
