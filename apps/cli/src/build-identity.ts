/** Exact artifact namespace; source/Changesets versions remain stable and unchanged. */
export interface BuildIdentity {
  readonly schemaVersion: 1;
  readonly sourceSha: string;
  readonly sourceVersion: string;
  readonly channel: "dev" | "alpha";
  readonly date: string;
  readonly runId: string;
  readonly attempt: string;
  readonly version: string;
}
const keys = [
  "schemaVersion",
  "sourceSha",
  "sourceVersion",
  "channel",
  "date",
  "runId",
  "attempt",
  "version",
];
const invalid = () =>
  new Error(
    "Invalid prerelease build identity. Use dev/alpha, a full source SHA and canonical date/run/attempt."
  );
const record = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid();
  return input as Record<string, unknown>;
};
const positive = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,15}$/.test(value) &&
  BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const stable = /^(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})$/;
export function isStableSourceVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    stable.test(value) &&
    value.split(".").every((n) => BigInt(n) <= BigInt(Number.MAX_SAFE_INTEGER))
  );
}
export function makeBuildIdentity(input: unknown): BuildIdentity {
  const value = record(input);
  if (Object.keys(value).some((key) => !keys.includes(key))) throw invalid();
  const { sourceSha, sourceVersion, channel, date, runId, attempt } = value;
  if (
    typeof sourceSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    /^0+$/.test(sourceSha) ||
    !isStableSourceVersion(sourceVersion) ||
    (channel !== "dev" && channel !== "alpha") ||
    typeof date !== "string" ||
    !/^[2-9][0-9]{7}$/.test(date) ||
    !positive(runId) ||
    !positive(attempt)
  )
    throw invalid();
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso)
    throw invalid();
  const version = `0.0.0-${channel}.${date}.${runId}.${attempt}`;
  if (
    (value["schemaVersion"] !== undefined && value["schemaVersion"] !== 1) ||
    (value["version"] !== undefined && value["version"] !== version)
  )
    throw invalid();
  return { schemaVersion: 1, sourceSha, sourceVersion, channel, date, runId, attempt, version };
}
export function validateBuildIdentity(input: unknown, expectedVersion?: string): BuildIdentity {
  const value = record(input);
  if (keys.some((key) => !Object.hasOwn(value, key))) throw invalid();
  const identity = makeBuildIdentity(value);
  if (expectedVersion !== undefined && identity.version !== expectedVersion) throw invalid();
  return identity;
}
