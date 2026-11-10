const AGENTMAIL_BASE_URL = "https://api.agentmail.to/v0";
const DEFAULT_TIMEOUT_MS = 180_000;

type MessageSummary = {
  message_id: string;
  timestamp: string;
  from: string;
  subject?: string;
  preview?: string;
};

type MessageDetail = MessageSummary & {
  text?: string;
  html?: string;
  extracted_text?: string;
  extracted_html?: string;
};

type ListMessagesResponse = {
  messages?: MessageSummary[];
};

export type AgentMailCodeOptions = {
  apiKey?: string;
  inboxId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Extract an Instagram six-digit login code without accepting longer numbers. */
export function extractInstagramCode(body: string): string | null {
  const text = body.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ");
  const anchored = [
    /(?:instagram\s+code|security\s+code|confirmation\s+code|login\s+code|use\s+(?:this\s+)?code)[^0-9]{0,80}(?<!\d)(\d{6})(?!\d)/i,
    /(?<!\d)(\d{6})(?!\d)[^a-z0-9]{0,80}(?:instagram\s+code|security\s+code|confirmation\s+code|login\s+code)/i,
  ];
  for (const pattern of anchored) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }

  const standalone = [...text.matchAll(/(?<!\d)(\d{6})(?!\d)/g)];
  const distinct = [...new Set(standalone.map(match => match[1]!))];
  return distinct.length === 1 ? distinct[0]! : null;
}

function requireConfig(options: AgentMailCodeOptions): {
  apiKey: string;
  inboxId: string;
} {
  const apiKey = options.apiKey?.trim() || process.env.AGENTMAIL_API_KEY?.trim();
  const inboxId = options.inboxId?.trim() || process.env.AGENTMAIL_ADDRESS?.trim();
  if (!apiKey || !inboxId) {
    throw new Error(
      "AgentMail is not configured. Set AGENTMAIL_API_KEY and AGENTMAIL_ADDRESS in .env",
    );
  }
  return { apiKey, inboxId };
}

async function getJson<T>(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`AgentMail request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function isInstagramMessage(message: MessageSummary): boolean {
  return /instagram/i.test(
    `${message.from} ${message.subject ?? ""} ${message.preview ?? ""}`,
  );
}

/**
 * Poll AgentMail for the newest Instagram email sent after `sinceTs`.
 * The API lists newest first. Message bodies and codes are never logged.
 */
export async function fetchLatestInstagramCode(
  sinceTs: number | Date,
  options: AgentMailCodeOptions = {},
): Promise<string> {
  const { apiKey, inboxId } = requireConfig(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const since = sinceTs instanceof Date ? sinceTs : new Date(sinceTs);
  if (!Number.isFinite(since.getTime())) {
    throw new Error("Invalid AgentMail since timestamp");
  }

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let delayMs = 2_000;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    try {
      const url = new URL(
        `${AGENTMAIL_BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/messages`,
      );
      url.searchParams.set("after", since.toISOString());
      url.searchParams.set("limit", "20");
      const listing = await getJson<ListMessagesResponse>(
        url.toString(),
        apiKey,
        fetchImpl,
      );

      const candidates = (listing.messages ?? [])
        .filter(isInstagramMessage)
        .filter((message) => new Date(message.timestamp).getTime() > since.getTime())
        .sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );

      for (const summary of candidates) {
        const previewCode = extractInstagramCode(
          `${summary.subject ?? ""}
${summary.preview ?? ""}`,
        );
        if (previewCode) return previewCode;

        const detail = await getJson<MessageDetail>(
          `${AGENTMAIL_BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(summary.message_id)}`,
          apiKey,
          fetchImpl,
        );
        const code = extractInstagramCode(
          [
            detail.subject,
            detail.preview,
            detail.extracted_text,
            detail.text,
            detail.extracted_html,
            detail.html,
          ]
            .filter(Boolean)
            .join("\n"),
        );
        if (code) return code;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (/\(40[13]\)/.test(lastError.message)) throw lastError;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(delayMs, remainingMs)),
    );
    delayMs = Math.min(Math.round(delayMs * 1.5), 10_000);
  }

  const suffix = lastError ? ` Last request: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for an Instagram email code.${suffix}`);
}
