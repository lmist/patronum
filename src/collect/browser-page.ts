/**
 * The parts of a browser page the collector uses.
 *
 * Stagehand pages and raw CDP tabs both fit these shapes, so every step can
 * work with either.
 */
export type DetailPage = {
  goto: (
    url: string,
    opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number },
  ) => Promise<unknown>;
  url: () => string;
  evaluate?: <R = unknown>(fn: string | (() => R)) => Promise<R>;
  sendCDP?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  context?: () => {
    cookies?: (urls?: string | string[]) => Promise<
      Array<{ name: string; value: string; domain?: string }>
    >;
  };
  close?: () => Promise<unknown>;
};

export type ScrapePage = {
  url: () => string;
  goto?: (
    url: string,
    opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number },
  ) => Promise<unknown>;
  evaluate?: <R = unknown>(fn: string | (() => R)) => Promise<R>;
  locator?: (selector: string) => { click: () => Promise<unknown> };
  mouse?: { wheel?: (x: number, y: number) => Promise<void> };
};
