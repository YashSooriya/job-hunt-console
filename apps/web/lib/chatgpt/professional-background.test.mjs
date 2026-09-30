import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatGptMemorySummaryInstruction,
  buildProfessionalBackgroundInstructions,
  buildProfessionalBackgroundSourceInstructions,
} from "./professional-background.ts";
import { applyChatGptTestingMode, chatGptInstructionBodyLimit } from "./testing-mode.ts";

const emptyInput = {
  displayName: "Test Candidate",
  facts: [], employment: [], education: [], skills: [], projects: [], publications: [], evidence: [], sourceDocuments: [],
};

test("testing-mode onboarding prompts reserve the warning budget and remain non-mutating across parts", () => {
  const input = {
    ...emptyInput,
    allowMemoryUpdate: true,
    facts: [{ fact_key: "profile_notes", value_json: "Relevant professional detail. ".repeat(420), verification_status: "verified" }],
  };
  const limit = chatGptInstructionBodyLimit(true);
  const tasks = buildProfessionalBackgroundInstructions({ ...input, allowMemoryUpdate: false }, limit);
  assert.ok(tasks.length > 1, "long background text should split rather than overflow");
  for (const task of tasks) {
    const message = applyChatGptTestingMode(task.instruction, true);
    assert.ok(message.startsWith("TEST ONLY — The following message is a test."));
    assert.ok(message.length <= 6000);
    assert.match(message, /do not add, save, or update anything in ChatGPT Memory/i);
    assert.doesNotMatch(message, /Please update your long-term Memory/);
    assert.doesNotMatch(message, /what you now remember/);
  }
});

test("testing-mode source bundles and profile summaries are prefixed without asking ChatGPT to update Memory", () => {
  const sourceDocuments = Array.from({ length: 9 }, (_, index) => ({
    id: `source-${index}`,
    source_type: "cv_upload",
    source_url: `https://files.example.test/${index}/${"detail".repeat(130)}`,
  }));
  const tasks = buildProfessionalBackgroundSourceInstructions({
    displayName: "Test Candidate",
    sourceDocuments,
    allowMemoryUpdate: false,
    includeJsonProfile: false,
  }, chatGptInstructionBodyLimit(true));
  assert.ok(tasks.length > 1);
  for (const task of tasks) {
    const message = applyChatGptTestingMode(task.instruction, true);
    assert.ok(message.length <= 6000);
    assert.ok(message.startsWith("TEST ONLY — The following message is a test."));
    assert.match(message, /do not save or update long-term Memory/i);
    assert.doesNotMatch(message, /Update your long-term Memory now/);
  }

  const summary = applyChatGptTestingMode(buildChatGptMemorySummaryInstruction(false), true);
  assert.ok(summary.length <= 6000);
  assert.match(summary, /test-only profile proposal/i);
  assert.doesNotMatch(summary, /earlier source message updated Memory/i);
});
