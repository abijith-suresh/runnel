import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getAgentGuide } from "../dist/agent-help.js";

test("guide topics return the requested section", () => {
  for (const [topic, heading] of [
    ["overview", "Overview"],
    ["query", "Query"],
    ["scripts", "Scripts"],
    ["errors", "Errors"],
    ["management", "Management"],
  ]) {
    const section = getAgentGuide(topic);
    assert(section.startsWith(`## ${heading}\n`));
    assert.equal(section.match(/^## /gm)?.length, 1);
  }
  assert(getAgentGuide().startsWith("## Overview\n"));
  assert.deepEqual(getAgentGuide("all").match(/^## .+$/gm), [
    "## Overview",
    "## Query",
    "## Scripts",
    "## Errors",
    "## Management",
  ]);
  assert.match(getAgentGuide("scripts"), /runnel run /);
});

test("CLI guide works offline and rejects unknown topics", () => {
  const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const run = (topic: string) =>
    spawnSync(process.execPath, [executable, "guide", topic], {
      env: { ...process.env, RUNNEL_HOME: "invalid-relative" },
      encoding: "utf8",
      timeout: 5000,
    });
  const result = run("scripts");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert(result.stdout.startsWith("## Scripts\n"));
  assert.match(result.stdout, /runnel run /);
  const invalid = run("unknown");
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Invalid guide topic/);
});
