import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { credentialStore } from "../apps/cli/dist/secrets.js";

// Optional integration check. It uses one synthetic credential and no catalog or database.
const secrets = credentialStore();
if (process.argv[2] === "read") {
  assert(
    (await Effect.runPromise(secrets.read(process.env.RUNNEL_CREDENTIAL_CHECK_REFERENCE))) ===
      process.env.RUNNEL_CREDENTIAL_CHECK_VALUE,
    "Native credential read did not match the synthetic value."
  );
} else {
  let reference;
  const value = `synthetic-${randomUUID()}`;
  try {
    reference = await Effect.runPromise(secrets.withStored(value, Effect.succeed));
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), "read"], {
      env: {
        ...process.env,
        RUNNEL_CREDENTIAL_CHECK_REFERENCE: reference,
        RUNNEL_CREDENTIAL_CHECK_VALUE: value,
      },
      stdio: "pipe",
      timeout: 15000,
    });
    assert(
      (await Effect.runPromise(secrets.read(reference))) === value,
      "Native credential read did not match the synthetic value."
    );
  } finally {
    if (reference) {
      assert.equal(await Effect.runPromise(secrets.remove(reference)), true);
      const missing = await Effect.runPromise(secrets.read(reference).pipe(Effect.result));
      assert(Result.isFailure(missing) && missing.failure.code === "SecretNotFound");
    }
  }
  process.stdout.write(
    `Native ${process.platform} credentials persisted across processes and were removed.\n`
  );
}
