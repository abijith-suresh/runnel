import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const guideSections = {
  overview: "Overview",
  query: "Query",
  scripts: "Scripts",
  errors: "Errors",
  management: "Management",
} as const;

export const agentGuideTopics = [...Object.keys(guideSections), "all", "skill"];

/** Resolve beside this module, independent of the caller's cwd or catalog. */
export function getAgentSkillPath(): string {
  return fileURLToPath(new URL("../skills/runnel/SKILL.md", import.meta.url));
}

export function readAgentSkill(): string {
  return readFileSync(getAgentSkillPath(), "utf8");
}

/** Offline help and the skill share one packaged source of truth. */
export function getAgentGuide(topic: string = "overview"): string {
  if (!agentGuideTopics.some((candidate) => candidate === topic))
    throw new RangeError(`Unknown guide topic. Choose ${agentGuideTopics.join(", ")}.`);
  const skill = readAgentSkill();
  if (topic === "skill") return skill;
  const body = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  if (topic === "all") return `${body}\n`;
  const heading = `## ${guideSections[topic as keyof typeof guideSections]}`;
  const sections = body.split(/(?=^## )/m);
  const section = sections.find(
    (candidate) => candidate.startsWith(`${heading}\n`) || candidate.startsWith(`${heading}\r\n`)
  );
  if (section === undefined) throw new Error(`Bundled guide section missing: ${topic}.`);
  return `${section.trimEnd()}\n`;
}
