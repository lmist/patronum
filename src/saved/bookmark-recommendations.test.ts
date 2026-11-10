import { expect, test } from "bun:test";
import { confirmedSave, explorePageInfo, recommendationsFromExplore, savedConnection } from "./bookmark-recommendations.js";

test("personalized Explore layouts yield distinct media and the next page", () => {
  const body = { more_available: true, next_max_id: "1", sectional_items: [
    { layout_content: { one_by_two_item: { media: { id: "123_456", pk: "123", code: "ABCde12" } } } },
    { layout_content: { medias: [
      { media: { id: "123_456", pk: "123", code: "ABCde12" } },
      { media: { id: "789_456", pk: "789", code: "XYZab34" } },
    ] } },
  ] };
  expect(recommendationsFromExplore(body)).toEqual([
    { shortcode: "ABCde12", mediaId: "123_456" },
    { shortcode: "XYZab34", mediaId: "789_456" },
  ]);
  expect(explorePageInfo(body)).toEqual({ next: "1", more: true });
});

test("saved-date pages use saved_time and require a continuation cursor", () => {
  const body = { data: { "1$xfb_cross_app_saves_infinite_scroll(after:$after)": {
    edges: [{ node: { source_app: "Instagram", content_url: "https://www.instagram.com/p/ABCde12/",
      saved_time: 1791300000, taken_at: 1500000000 } },
      { node: { source_app: "Facebook", content_url: "https://www.facebook.com/example", saved_time: 1791300001 } }],
    page_info: { has_next_page: true, end_cursor: "cursor2" },
  } } };
  expect(savedConnection(body)).toEqual({
    entries: [{ shortcode: "ABCde12", savedTime: 1791300000, contentUrl: "https://www.instagram.com/p/ABCde12/" }],
    next: "cursor2",
  });
  expect(() => savedConnection({ data: { xfb_cross_app_saves_infinite_scroll: {
    edges: [], page_info: { has_next_page: true, end_cursor: null },
  } } })).toThrow("cursor");
});

test("save confirmation must identify the requested media as saved", () => {
  const body = { data: { xig_media_save: { media: { id: "123_456", has_viewer_saved: true } } } };
  expect(confirmedSave(body, "123_456")).toBe(true);
  expect(confirmedSave(body, "789_456")).toBe(false);
  expect(confirmedSave({ data: { xig_media_save: { media: { id: "123_456", has_viewer_saved: false } } } }, "123_456")).toBe(false);
});
