#!/usr/bin/env node
/**
 * Stagehand's AI SDK client puts system prompts in `messages[]`, which triggers
 * AI SDK v5 warnings unless allowSystemInMessages: true is set.
 * Agent handlers already pass it; act/observe/extract paths in llm/aisdk.js do not.
 * Re-apply after every install.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "node_modules/@browserbasehq/stagehand/dist/esm/lib/v3/llm/aisdk.js",
  "node_modules/@browserbasehq/stagehand/dist/cjs/lib/v3/llm/aisdk.js",
  "node_modules/@browserbasehq/stagehand/dist/esm/lib/v3/external_clients/aisdk.js",
  "node_modules/@browserbasehq/stagehand/dist/cjs/lib/v3/external_clients/aisdk.js",
];

const pairs = [
  // esm generateObject
  [
    `objectResponse = await generateObject({
                    model: this.model,
                    messages: formattedMessages,
                    schema: options.response_model.schema,
                    temperature,`,
    `objectResponse = await generateObject({
                    model: this.model,
                    messages: formattedMessages,
                    schema: options.response_model.schema,
                    temperature,
                    allowSystemInMessages: true,`,
  ],
  // cjs generateObject
  [
    `objectResponse = await (0, ai_1.generateObject)({
                    model: this.model,
                    messages: formattedMessages,
                    schema: options.response_model.schema,
                    temperature,`,
    `objectResponse = await (0, ai_1.generateObject)({
                    model: this.model,
                    messages: formattedMessages,
                    schema: options.response_model.schema,
                    temperature,
                    allowSystemInMessages: true,`,
  ],
  // esm generateText
  [
    `textResponse = await generateText({
                model: this.model,
                messages: formattedMessages,`,
    `textResponse = await generateText({
                model: this.model,
                messages: formattedMessages,
                allowSystemInMessages: true,`,
  ],
  // cjs generateText
  [
    `textResponse = await (0, ai_1.generateText)({
                model: this.model,
                messages: formattedMessages,`,
    `textResponse = await (0, ai_1.generateText)({
                model: this.model,
                messages: formattedMessages,
                allowSystemInMessages: true,`,
  ],
  // external client esm generateObject
  [
    `const response = await generateObject({
                model: this.model,
                messages: formattedMessages,
                schema: options.response_model.schema,
            });`,
    `const response = await generateObject({
                model: this.model,
                messages: formattedMessages,
                schema: options.response_model.schema,
                allowSystemInMessages: true,
            });`,
  ],
  // external client cjs generateObject
  [
    `const response = await (0, ai_1.generateObject)({
                model: this.model,
                messages: formattedMessages,
                schema: options.response_model.schema,
            });`,
    `const response = await (0, ai_1.generateObject)({
                model: this.model,
                messages: formattedMessages,
                schema: options.response_model.schema,
                allowSystemInMessages: true,
            });`,
  ],
  // external client esm generateText
  [
    `const response = await generateText({
            model: this.model,`,
    `const response = await generateText({
            model: this.model,
            allowSystemInMessages: true,`,
  ],
  // external client cjs generateText
  [
    `const response = await (0, ai_1.generateText)({
            model: this.model,`,
    `const response = await (0, ai_1.generateText)({
            model: this.model,
            allowSystemInMessages: true,`,
  ],
];

let changed = 0;
for (const rel of files) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) continue;
  let s = readFileSync(abs, "utf8");
  if (s.includes("allowSystemInMessages: true")) {
    console.log(`ok (already): ${rel}`);
    continue;
  }
  let next = s;
  for (const [from, to] of pairs) {
    if (next.includes(from) && !next.includes(to)) {
      next = next.replace(from, to);
    }
  }
  if (next !== s) {
    writeFileSync(abs, next);
    changed++;
    console.log(`patched: ${rel}`);
  } else {
    console.log(`skip (no match): ${rel}`);
  }
}
console.log(`stagehand aisdk patch done (files changed: ${changed})`);
