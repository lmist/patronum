/**
 * One collection run.
 *
 * `CollectOptions` is what the caller asks for. `CollectRun` is everything
 * the steps share while the run is in progress: the open browser, the
 * profile being read, what an earlier run left behind, and the notes that
 * end up in the saved profile.
 */
import type { EnsuredSession } from "../sign-in/ensure-session.js";
import type { TrafficRecorder } from "../api-map/traffic-recorder.js";
import type { InstagramUiMap } from "../api-map/ui-map.js";
import type { CdpDetailBrowser } from "./cdp-detail.js";
import type { MediaItem } from "./post-shape.js";
import type { PriorProfile } from "./resume.js";

export type CollectOptions = {
  /** Profile URL, e.g. https://www.instagram.com/<handle>. */
  url: string;
  /** Most posts (and most reels) to keep. */
  max: number;
  /** Where to save the profile JSON; defaults to data/profiles/<handle>-profile.json. */
  out?: string;
  forceLogin: boolean;
  skipLlmPreflight: boolean;
  /** Wipe the saved profile and media before starting. */
  fresh: boolean;
  /** Continue from the saved profile when there is one. */
  resume: boolean;
  scrollRounds?: number;
  /** Open every post for its full media and caption. */
  detail: boolean;
  /** Posts tab only; drop reels and standalone videos. */
  skipReels: boolean;
  /** How many posts to open at once. */
  workers: number;
};

export type CollectRun = {
  options: CollectOptions;
  url: string;
  /** Handle taken from the URL. */
  handle: string;
  outPath: string;
  scrollRounds: number;
  /** The profile an earlier run saved, when resuming. */
  prior: PriorProfile | null;
  /** Remarks saved with the profile; steps append to this. */
  notes: string[];
  session: EnsuredSession;
  stagehand: EnsuredSession["stagehand"];
  page: EnsuredSession["page"];
  uiMap: InstagramUiMap;
  /** What the browser has seen on the network during this run. */
  traffic: TrafficRecorder;
  /** Raw CDP tabs for opening posts; created on first use, closed by collectProfile. */
  cdpDetail?: CdpDetailBrowser;
};

/** The posts and reels as they stand part-way through a run. Steps update this in place. */
export type PostLists = {
  posts: MediaItem[];
  reels: MediaItem[];
  /** Shortcodes that need no further work. */
  complete: Set<string>;
};
