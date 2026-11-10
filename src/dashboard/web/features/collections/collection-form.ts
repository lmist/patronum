export interface CollectionDraft {
  handle: string;
  max: string;
  media: "all" | "images";
  goal: "download" | "analyze";
  source: "discover" | "saved";
  mapSurface: "profile" | "saved";
  browserWorkers: string;
  downloadWorkers: string;
  analysisWorkers: string;
  timeoutMinutes: string;
  showBrowser: boolean;
  forceLogin: boolean;
  skipLlmCheck: boolean;
  allFrames: boolean;
}

export const collectionDefaults: CollectionDraft = {
  handle: "", max: "30", media: "all", goal: "download", source: "discover", mapSurface: "profile",
  browserWorkers: "2", downloadWorkers: "4", analysisWorkers: "2", timeoutMinutes: "30",
  showBrowser: false, forceLogin: false, skipLlmCheck: false, allFrames: false,
};
export type CollectionErrors = Partial<Record<keyof CollectionDraft | "session", string>>;

export function normalizeHandle(value: string) { return value.trim().replace(/^@/, ""); }
export function handleError(value: string) {
  return /^[A-Za-z0-9._]{1,30}$/.test(normalizeHandle(value)) ? undefined : "Enter an Instagram handle of 1–30 letters, numbers, periods, or underscores.";
}

export function collectionRequest(draft: CollectionDraft): {body?: Record<string, unknown>; errors: CollectionErrors} {
  const errors: CollectionErrors = {};
  const handle = normalizeHandle(draft.handle);
  const invalidHandle = handleError(draft.handle);
  if (invalidHandle) errors.handle = invalidHandle;
  const number = (key: "max" | "browserWorkers" | "downloadWorkers" | "analysisWorkers" | "timeoutMinutes", label: string, max = Number.MAX_SAFE_INTEGER) => {
    const value = Number(draft[key]);
    if (!draft[key].trim() || !Number.isSafeInteger(value) || value < 1 || value > max) {
      errors[key] = max === Number.MAX_SAFE_INTEGER ? `${label} must be a whole number of at least 1.` : `${label} must be a whole number from 1 to ${max}.`;
    }
    return value;
  };
  const max = number("max", "Post limit");
  const browserWorkers = number("browserWorkers", "Browser tabs", 8);
  const downloadWorkers = number("downloadWorkers", "Parallel downloads", 16);
  const timeoutMinutes = number("timeoutMinutes", "Time limit", 360);
  const analysisWorkers = draft.goal === "analyze" ? number("analysisWorkers", "Parallel analyses", 8) : Number(collectionDefaults.analysisWorkers);
  if (!["all", "images"].includes(draft.media)) errors.media = "Choose a media type.";
  if (!["download", "analyze"].includes(draft.goal)) errors.goal = "Choose a collection goal.";
  if (!["discover", "saved"].includes(draft.source)) errors.source = "Choose which posts to collect.";
  if (Object.keys(errors).length) return {errors};
  return {errors, body: {
    handle, max, "skip-reels": draft.media === "images", "skip-analyze": draft.goal === "download",
    "skip-llm-preflight": draft.goal === "download" || draft.skipLlmCheck, "skip-kb": true,
    "reuse-grid": draft.source === "saved", "detail-workers": browserWorkers,
    "dl-workers": downloadWorkers, "analyze-workers": analysisWorkers, timeout: `${timeoutMinutes}m`,
    "show-browser": draft.showBrowser, "force-login": draft.forceLogin,
    "all-frames": draft.goal === "analyze" && draft.allFrames,
  }};
}
