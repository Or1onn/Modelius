// errors.ts — turn raw provider/API errors into short, friendly user-facing text.

// Backend stream errors arrive as "Provider STATUS[ (retry-after: Ns)]: <body>"
// (body is usually the provider's JSON). Anything else is already a plain message.
export function humanizeError(raw: string): string {
  if (/failed to fetch|networkerror|fetch failed/i.test(raw)) {
    return "Network error — check your connection and try again.";
  }

  const m = raw.match(/^(OpenAI|ChatGPT|Anthropic)\s+(\d{3})(?:\s+\(retry-after:\s*(\d+)s\))?:\s*([\s\S]*)$/);
  if (!m) return raw; // e.g. "No OpenAI API key configured."
  const [, provider, statusStr, retry, body] = m;
  const status = Number(statusStr);

  // Pull the provider's own error type/message out of the JSON body if present.
  let apiType = "";
  let apiMsg = "";
  try {
    const j = JSON.parse(body);
    apiType = j?.error?.type ?? "";
    apiMsg = j?.error?.message ?? "";
  } catch {
    /* body wasn't JSON */
  }
  if (apiMsg === "Error") apiMsg = ""; // some endpoints return a useless "Error"
  const model = apiMsg.match(/model:\s*(\S+)/)?.[1] ?? "";

  if (apiType === "overloaded_error") {
    return `${provider}: servers are overloaded right now. Try again in a moment.`;
  }

  switch (status) {
    case 400:
      return `${provider}: request rejected${apiMsg ? ` — ${apiMsg}` : ""}.`;
    case 401:
      return `${provider}: sign-in failed. Reconnect the account or re-enter your API key.`;
    case 403:
      return `${provider}: access denied${apiMsg ? ` — ${apiMsg}` : ""}. This model may not be on your plan.`;
    case 404:
      return `${provider}: model not found${model ? ` (${model})` : ""}. Pick another model.`;
    case 413:
      return `${provider}: this conversation is too long for the selected model.`;
    case 429:
      return `${provider}: rate limit reached${apiMsg ? ` — ${apiMsg}` : ""}.${retry ? ` Try again in ${retry}s.` : " Please wait a bit and try again."}`;
    case 500:
    case 502:
    case 503:
    case 529:
      return `${provider}: service temporarily unavailable (${status}). Try again shortly.`;
    default:
      return `${provider} error ${status}${apiMsg ? `: ${apiMsg}` : ""}.`;
  }
}
