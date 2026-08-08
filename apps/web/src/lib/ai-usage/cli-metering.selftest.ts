/**
 * Run: npm run test:cli-metering --workspace @agents/web
 */
import assert from "node:assert/strict";
import {
  cliMeteringDisabled,
  resolveCliMeteringUserId,
  withCliAiUsageMetering,
} from "./cli-metering";

const SAMPLE_USER = "11111111-1111-4111-8111-111111111111";

function testResolveUserId(): void {
  assert.equal(
    resolveCliMeteringUserId({
      argv: ["node", "eval.ts", "--user", SAMPLE_USER],
    }),
    SAMPLE_USER
  );
  assert.equal(
    resolveCliMeteringUserId({
      argv: [`--user=${SAMPLE_USER}`],
    }),
    SAMPLE_USER
  );
  assert.equal(
    resolveCliMeteringUserId({ userId: SAMPLE_USER, argv: [] }),
    SAMPLE_USER
  );
  assert.equal(resolveCliMeteringUserId({ argv: ["--user", "not-a-uuid"] }), null);
}

function testNoMeterFlag(): void {
  assert.equal(cliMeteringDisabled(["--no-meter"]), true);
  assert.equal(cliMeteringDisabled([]), false);
}

async function testNoMeterSkipsBinding(): Promise<void> {
  let ran = false;
  await withCliAiUsageMetering(
    async () => {
      ran = true;
      return 1;
    },
    {
      label: "selftest",
      argv: ["--no-meter"],
      require: true,
    }
  );
  assert.equal(ran, true);
}

async function testMissingUserThrowsWhenRequired(): Promise<void> {
  const prev = process.env.AI_USAGE_CLI_USER_ID;
  delete process.env.AI_USAGE_CLI_USER_ID;
  try {
    await assert.rejects(
      () =>
        withCliAiUsageMetering(async () => "x", {
          label: "selftest-missing-user",
          argv: [],
          require: true,
        }),
      /missing tenant for metering/
    );
  } finally {
    if (prev !== undefined) process.env.AI_USAGE_CLI_USER_ID = prev;
  }
}

async function main(): Promise<void> {
  testResolveUserId();
  testNoMeterFlag();
  await testNoMeterSkipsBinding();
  await testMissingUserThrowsWhenRequired();
  console.log("cli-metering.selftest: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
