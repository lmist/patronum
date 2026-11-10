/**
 * Small HTTP helpers: JSON replies, 404s, request bodies and the built web UI.
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { FRONTEND_DIR } from "./settings";

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function notFound(msg = "not found") {
  return new Response(msg, { status: 404 });
}

export async function serveStatic(pathname: string) {
  if (pathname === "/redesign") return Response.redirect("/redesign/", 308);
  let name: string;
  try { name = decodeURIComponent(pathname.startsWith("/redesign/") ? pathname.slice(10) : pathname.slice(1)); }
  catch { return notFound(); }
  const abs = resolve(FRONTEND_DIR, name || "index.html");
  if (!abs.startsWith(FRONTEND_DIR + "/")) return notFound();
  const file = Bun.file(abs);
  if (await file.exists()) {
    if (!realpathSync(abs).startsWith(realpathSync(FRONTEND_DIR) + "/")) return notFound();
    return new Response(file, {headers:{"cache-control":name.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache"}});
  }
  if (!name.includes(".")) {
    const index = Bun.file(join(FRONTEND_DIR, "index.html"));
    if (await index.exists()) return new Response(index,{headers:{"cache-control":"no-cache"}});
  }
  return notFound();
}

export class BadRequest extends Error {}

// ————————— POST handlers —————————
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const j = await req.json();
    if (j == null || typeof j !== "object" || Array.isArray(j)) throw new Error("expected object");
    return j as Record<string, unknown>;
  } catch (e) {
    throw new BadRequest("body must be a JSON object");
  }
}
