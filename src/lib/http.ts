const REDACTED_PARAMS = ["access_token", "token"];

/** Replace secret query params (access_token, token) with REDACTED — for safe logging. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of REDACTED_PARAMS) {
      if (u.searchParams.has(key)) u.searchParams.set(key, "REDACTED");
    }
    return u.toString();
  } catch {
    return url; // not a parseable URL; nothing to redact
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string, // pass a redacted URL — this ends up in the message
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body}`);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number; // aborts a hung request; default 30s
}

/**
 * Thin wrapper around fetch for JSON APIs. Adds a timeout, throws `HttpError` on a
 * non-2xx response (keeping the body for diagnostics), and turns invalid JSON and
 * network failures into clear errors. URLs are redacted in all error messages so the
 * access token never lands in logs. Callers validate the shape (e.g. with Zod).
 *
 * Single attempt — retries live at the job/queue level, not here. Not for binary or
 * streamed downloads; those stream `response.body` directly.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 30_000, ...init } = opts;
  init.signal = init.signal ?? AbortSignal.timeout(timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`request to ${redactUrl(url)} failed: ${(err as Error).message}`, { cause: err });
  }

  const body = await res.text();
  if (!res.ok) {
    throw new HttpError(res.status, redactUrl(url), body.slice(0, 500));
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`invalid JSON from ${redactUrl(url)}: ${body.slice(0, 200)}`);
  }
}
