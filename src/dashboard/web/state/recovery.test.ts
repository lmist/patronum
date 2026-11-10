import { expect, test } from "bun:test";
import { collectionRecovery } from "./recovery";

test("HTTP rejection advises waiting without suggesting an account reset", () => {
  for (const error of ["instagram_http_rejection", "http_rejected", "net::ERR_HTTP_RESPONSE_CODE_FAILURE", "HTTP 429", "HTTP 403"]) {
    const recovery = collectionRecovery(error);
    expect(recovery.account).toBe(false);
    expect(recovery.advice).toContain("Wait before");
    expect(recovery.advice).toContain("saved post list");
  }
});

test("other failures retain account access without assuming an auth problem", () => {
  expect(collectionRecovery("analysis checkpoint write failed").advice).toContain("Inspect the failed stage");
  expect(collectionRecovery("auth failed").account).toBe(true);
});
