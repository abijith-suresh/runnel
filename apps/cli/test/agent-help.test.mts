import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agentGuideTopics,
  getAgentGuide,
  getAgentSkillPath,
  readAgentSkill,
} from "../dist/agent-help.js";

test("skill access returns the actual packaged source and an absolute file path", () => {
  assert(isAbsolute(getAgentSkillPath()));
  assert.equal(readAgentSkill(), readFileSync(getAgentSkillPath(), "utf8"));
  assert.equal(getAgentGuide("skill"), readAgentSkill());
});

test("each guide topic exposes its section from the same skill without frontmatter", () => {
  const skill = readAgentSkill();
  const all = getAgentGuide("all");
  assert.equal(getAgentGuide(), getAgentGuide("overview"));
  assert(!all.startsWith("---"));
  assert(skill.includes(all.trimEnd()));
  for (const topic of agentGuideTopics.filter((topic) => topic !== "all" && topic !== "skill")) {
    const section = getAgentGuide(topic);
    assert.equal(section.match(/^## /gm)?.length, 1);
    assert(all.includes(section.trimEnd()));
    assert(section.endsWith("\n"));
  }
  assert.equal(all.match(/^## /gm)?.length, agentGuideTopics.length - 2);
});

test("invalid topics are rejected rather than interpreted as file paths", () => {
  for (const topic of ["", "unknown", "../package.json", "constructor", "toString", "Query"])
    assert.throws(() => getAgentGuide(topic), RangeError);
});

test("CLI guide and skill commands work offline and print the packaged instructions", () => {
  const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  for (const [args, expected] of [
    [["guide"], getAgentGuide()],
    [["guide", "query"], getAgentGuide("query")],
    [["guide", "scripts"], getAgentGuide("scripts")],
    [["guide", "management"], getAgentGuide("management")],
    [["guide", "all"], getAgentGuide("all")],
    [["skill"], readAgentSkill()],
    [["skill", "print"], readAgentSkill()],
    [["skill", "path"], `${getAgentSkillPath()}\n`],
  ] as const) {
    const result = spawnSync(process.execPath, [executable, ...args], {
      env: { ...process.env, RUNNEL_HOME: "invalid-relative" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected);
  }
  for (const args of [
    ["guide", "unknown"],
    ["skill", "install"],
    ["guide", "query", "--env", "local"],
  ]) {
    const result = spawnSync(process.execPath, [executable, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
});

test("relocated help resolves beside its module without catalog access or dependencies", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel agent help # "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dist"));
  mkdirSync(join(directory, "skills/runnel"), { recursive: true });
  copyFileSync(
    new URL("../dist/agent-help.js", import.meta.url),
    join(directory, "dist/agent-help.js")
  );
  copyFileSync(getAgentSkillPath(), join(directory, "skills/runnel/SKILL.md"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
  const url = pathToFileURL(join(directory, "dist/agent-help.js")).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const help = await import(${JSON.stringify(url)});
       process.stdout.write(JSON.stringify({
         path: help.getAgentSkillPath(),
         skill: help.readAgentSkill(),
         guide: help.getAgentGuide('query')
       }));`,
    ],
    {
      cwd: tmpdir(),
      env: { ...process.env, RUNNEL_HOME: "invalid-relative-catalog" },
      encoding: "utf8",
      timeout: 10000,
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.path, join(directory, "skills/runnel/SKILL.md"));
  assert.equal(output.skill, readAgentSkill());
  assert.equal(output.guide, getAgentGuide("query"));
  // Windows checkouts and copied skills can use CRLF without changing topic lookup.
  writeFileSync(
    join(directory, "skills/runnel/SKILL.md"),
    readAgentSkill().replace(/\r?\n/g, "\r\n")
  );
  const crlf = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { getAgentGuide } = await import(${JSON.stringify(url)}); process.stdout.write(getAgentGuide('query'));`,
    ],
    { cwd: tmpdir(), encoding: "utf8", timeout: 10000 }
  );
  assert.equal(crlf.status, 0, crlf.stderr);
  assert.equal(
    crlf.stdout.replaceAll("\r\n", "\n"),
    getAgentGuide("query").replaceAll("\r\n", "\n")
  );
});
