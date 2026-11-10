import { expect, test } from "bun:test";
import { networkMapArgs } from "./map-network.js";

test("network mapping requires an explicit safe handle", () => {
  expect(networkMapArgs(["--handle", "@designerbriefs"])).toEqual({ handle: "designerbriefs", surface: "profile" });
  for (const args of [[], ["--handle", "../secret"], ["--handle", ".."], ["--handle", "x;pwd"], ["--handle", "x", "--extra"]]) {
    expect(() => networkMapArgs(args)).toThrow();
  }
});

test("network mapping walks the Saved tab only on the owner profile", () => {
  expect(networkMapArgs(["--handle", "owner", "--surface", "saved"])).toEqual({ handle: "owner", surface: "saved" });
  expect(networkMapArgs(["--surface", "saved", "--handle", "owner"])).toEqual({ handle: "owner", surface: "saved" });
  expect(networkMapArgs(["--handle", "owner", "--surface", "profile"])).toEqual({ handle: "owner", surface: "profile" });
  for (const args of [["--handle", "owner", "--surface"], ["--handle", "owner", "--surface", "saved", "--surface", "saved"],
    ["--handle", "owner", "--surface", "collections"], ["--surface", "saved"]]) {
    expect(() => networkMapArgs(args)).toThrow();
  }
});
