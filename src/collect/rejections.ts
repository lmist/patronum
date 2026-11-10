/**
 * When Instagram says no.
 *
 * The errors raised when a page will not load in time or Instagram answers
 * with an HTTP rejection. The run stops on the first rejection.
 */
import { getObservedDocumentResponse } from "../api-map/traffic-recorder.js";

export class DetailNavigationTimeout extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`detail navigation timed out after ${timeoutMs}ms: ${url}`);
    this.name = "DetailNavigationTimeout";
  }
}

export class InstagramHttpRejectionError extends Error {
  readonly code = "instagram-http-rejection" as const;
  readonly retryable = false;
  constructor(
    readonly url: string,
    readonly transportError: string,
    readonly httpStatus: number | null = null,
    readonly retryAfter: string | null = null,
  ) {
    super(`Instagram HTTP response failed (${httpStatus && !transportError.startsWith(`HTTP ${httpStatus}`) ? `HTTP ${httpStatus}; ` : ""}${transportError}) at ${url}${retryAfter ? `; Retry-After: ${retryAfter}` : ""}; collection stopped. Inspect the response before retrying through the dashboard.`);
    this.name = "InstagramHttpRejectionError";
  }
}

/** Read status/Retry-After only from a response Stagehand already received. */
export function assertProfileNavigationResponse(response: unknown, url: string): void {
  if (!response || typeof response !== "object") return;
  const reply = response as { status?: () => number; headers?: () => Record<string, string> };
  if (typeof reply.status !== "function") return;
  const status = reply.status();
  if (!Number.isInteger(status) || status < 400) return;
  let retryAfter: string | null = null;
  try { if (typeof reply.headers === "function") retryAfter = reply.headers()["retry-after"] ?? null; }
  catch { /* status alone is enough to reject */ }
  throw new InstagramHttpRejectionError(url, `HTTP ${status}`, status, retryAfter);
}

export function httpRejection(url: string, error: unknown, page?: object): InstagramHttpRejectionError | null {
  if (error instanceof InstagramHttpRejectionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (!/ERR_HTTP_RESPONSE_CODE_FAILURE/.test(message)) return null;
  const own = page as { documentResponse?: (url: string) => { status: number; retryAfter: string | null } | undefined } | undefined;
  const observed = own?.documentResponse?.(url) ?? (page ? getObservedDocumentResponse(page, url) : undefined);
  return new InstagramHttpRejectionError(url, message, observed?.status || null, observed?.retryAfter ?? null);
}
