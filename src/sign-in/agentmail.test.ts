import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractInstagramCode } from "./agentmail.js";

describe("AgentMail Instagram code extraction", () => {
  it("extracts a six-digit code from a fixture email body", () => {
    const fixture = `
      <html><body>
        <p>Hi,</p>
        <p>Use this code to confirm your Instagram login:</p>
        <strong>483 ?</strong>
        <p>Your Instagram security code is 731942.</p>
      </body></html>
    `;
    assert.equal(extractInstagramCode(fixture), "731942");
  });

  it("does not take six digits out of a longer number", () => {
    assert.equal(
      extractInstagramCode("Your Instagram security reference is 1234567."),
      null,
    );
  });
});

it("accepts the same code repeated across duplicate HTML representations", () => {
  assert.equal(extractInstagramCode("Enter the number below: <b>123456</b>\nEnter the number below: <b>123456</b>"), "123456");
  assert.equal(extractInstagramCode("Enter the number below: <b>123456</b>\nAnother number: <b>654321</b>"), null);
});
