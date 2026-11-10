/**
 * What one post looks like.
 *
 * The record the collector writes for every post or reel, plus the shapes it
 * asks the model to fill in for the profile header and grid.
 */
import { z } from "zod";

export const MediaItemSchema = z.object({
  mediaOwnershipVersion: z.literal(1).optional(),
  /** 1 = engagement/duration fields were read from this item's record (absent ones were not stated). */
  metricsVersion: z.literal(1).optional(),
  detailSource: z.enum(["embedded-json", "graphql", "api-info"]).optional(),
  carouselComplete: z.boolean().optional(),
  captionComplete: z.boolean().optional(),
  detailStatus: z.enum(["complete", "incomplete", "failed"]).optional(),
  detailError: z.string().nullable().optional(),
  detailAttempts: z.number().int().nonnegative().optional(),
  fromProfileGrid: z.boolean().optional(),
  shortcode: z
    .string()
    .nullable()
    .optional()
    .describe("Post shortcode from /p/ or /reel/ URL path segment"),
  id: z.string().nullable().optional().describe("Alternate id if shortcode missing"),
  type: z
    .enum(["image", "video", "carousel", "reel"])
    .nullable()
    .optional()
    .describe("Media type from UI indicators or URL"),
  caption: z
    .string()
    .nullable()
    .optional()
    .describe("Caption text only if visible without inventing"),
  timestamp: z
    .string()
    .nullable()
    .optional()
    .describe("Relative or absolute time if visible"),
  permalink: z
    .string()
    .nullable()
    .optional()
    .describe("Permalink to /p/SHORTCODE/ or /reel/SHORTCODE/"),
  mediaUrls: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("img/video/source src URLs from DOM only — never invent"),
  thumbnailUrl: z
    .string()
    .nullable()
    .optional()
    .describe("Grid thumbnail img src if present"),
  isVideo: z
    .boolean()
    .nullable()
    .optional()
    .describe("True when video/reel/clip indicator is present"),
  carouselMedia: z
    .array(
      z.object({
        mediaUrl: z.string().nullable().optional(),
        thumbnailUrl: z.string().nullable().optional(),
        isVideo: z.boolean().nullable().optional(),
      }),
    )
    .nullable()
    .optional()
    .describe("Carousel slides if detail open"),
  likeCount: z.number().int().nonnegative().nullable().optional(),
  commentCount: z.number().int().nonnegative().nullable().optional(),
  playCount: z.number().int().nonnegative().nullable().optional(),
  viewCount: z.number().int().nonnegative().nullable().optional(),
  videoDurationSec: z.number().nonnegative().nullable().optional(),
});

export const HeaderSchema = z.object({
  username: z.string().nullable().optional().describe("Username without @"),
  fullName: z.string().nullable().optional().describe("Display name"),
  profilePicUrl: z
    .string()
    .nullable()
    .optional()
    .describe("Profile picture img src from DOM"),
  bioRaw: z.string().nullable().optional().describe("Full bio text as shown"),
  location: z
    .string()
    .nullable()
    .optional()
    .describe("Location/address line if shown"),
  counts: z
    .object({
      posts: z.number().nullable().optional().describe("Posts count as number"),
      followers: z
        .number()
        .nullable()
        .optional()
        .describe("Followers count as number"),
      following: z
        .number()
        .nullable()
        .optional()
        .describe("Following count as number"),
    })
    .nullable()
    .optional(),
  notes: z.array(z.string()).nullable().optional(),
});

export const GridSchema = z.object({
  items: z
    .array(MediaItemSchema)
    .nullable()
    .optional()
    .describe("Grid items visible on this tab"),
  notes: z.array(z.string()).nullable().optional(),
});

export const BioOnlySchema = z.object({
  bioRaw: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  notes: z.array(z.string()).nullable().optional(),
});

export type MediaItem = z.infer<typeof MediaItemSchema>;

export type HeaderExtract = z.infer<typeof HeaderSchema>;

/** Reel or standalone feed video — not an image or carousel post. */
export function isReelOrVideoPost(item: {
  type?: string | null;
  permalink?: string | null;
  isVideo?: boolean | null;
}): boolean {
  const t = (item.type ?? "").toLowerCase();
  if (t === "carousel" || t === "image" || t === "photo") return false;
  if (t === "reel" || t === "video") return true;
  if (item.permalink && /\/reel\//i.test(item.permalink)) return true;
  if (item.isVideo === true) return true;
  return false;
}
