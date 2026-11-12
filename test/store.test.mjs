import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_DRAFT } from "../shared/plan.ts";
import { loadDraft, saveDraft } from "../server/store.ts";

test("the editor draft round-trips through its file", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "session-watch-")), "sub", "draft.json");
  assert.deepEqual(await loadDraft(file), EMPTY_DRAFT);
  const draft = {
    ...EMPTY_DRAFT,
    selected: ["a", "b"],
    followUps: [
      { id: "f1", kind: "send", after: ["w1"], target: "w1", text: "검토해", cwd: "", provider: "claude", modeId: "", title: "" },
    ],
    shutdown: false,
    seq: 2,
  };
  await saveDraft(file, draft);
  assert.deepEqual(await loadDraft(file), draft);
});

test("a corrupt draft falls back to the empty form", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "session-watch-")), "draft.json");
  writeFileSync(file, "{ not json");
  assert.deepEqual(await loadDraft(file), EMPTY_DRAFT);
});
