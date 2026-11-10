export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store" });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(value?.error ?? "Request failed (" + response.status + ")", response.status);
  if (value === null) throw new ApiError("The dashboard returned an unreadable response.", response.status);
  return value as T;
}
const pending = new Set<string>();
export async function act<T>(path: string, body: unknown): Promise<T> {
  const key = path + JSON.stringify(body);
  if (pending.has(key)) throw new Error("This action is already being submitted.");
  pending.add(key);
  try {
    const response = await fetch(path, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body) });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value?.ok) throw new ApiError(value?.error ?? "Action failed (" + response.status + ")", response.status);
    return value as T;
  } finally { pending.delete(key); }
}
