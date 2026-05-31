import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateCronAuth, type CronAuthInput } from "../cron";

function input(overrides: Partial<CronAuthInput> = {}): CronAuthInput {
  return {
    vercelCronHeader: null,
    queryToken: null,
    bearerToken: null,
    adminToken: null,
    cronSecret: null,
    ...overrides,
  };
}

describe("evaluateCronAuth", () => {
  it("authorizes a bearer token matching ADMIN_TOKEN", () => {
    assert.equal(
      evaluateCronAuth(
        input({ adminToken: "secret-admin", bearerToken: "secret-admin" }),
      ),
      true,
    );
  });

  it("authorizes a ?token= matching ADMIN_TOKEN", () => {
    assert.equal(
      evaluateCronAuth(
        input({ adminToken: "secret-admin", queryToken: "secret-admin" }),
      ),
      true,
    );
  });

  it("authorizes a bearer token matching CRON_SECRET", () => {
    assert.equal(
      evaluateCronAuth(
        input({ cronSecret: "cron-secret", bearerToken: "cron-secret" }),
      ),
      true,
    );
  });

  it("rejects a wrong token", () => {
    assert.equal(
      evaluateCronAuth(
        input({ adminToken: "secret-admin", bearerToken: "nope" }),
      ),
      false,
    );
  });

  it("rejects when no token and no header are present", () => {
    assert.equal(
      evaluateCronAuth(input({ adminToken: "secret-admin" })),
      false,
    );
  });

  // The removed `?cron=1` bypass: a bare "1" must not authorize unless it
  // actually matches a configured secret.
  it("does not authorize a bare '1' query token (the old ?cron=1 bypass is gone)", () => {
    assert.equal(
      evaluateCronAuth(input({ adminToken: "secret-admin", queryToken: "1" })),
      false,
    );
  });

  it("never authorizes against an empty/unset secret even with an empty token", () => {
    assert.equal(
      evaluateCronAuth(input({ adminToken: "", bearerToken: "" })),
      false,
    );
    assert.equal(
      evaluateCronAuth(input({ adminToken: null, bearerToken: "" })),
      false,
    );
  });

  describe("x-vercel-cron header fallback", () => {
    it("authorizes the header when NO CRON_SECRET is configured (legacy)", () => {
      assert.equal(
        evaluateCronAuth(input({ vercelCronHeader: "1", cronSecret: null })),
        true,
      );
    });

    it("does NOT trust the header alone once CRON_SECRET is configured", () => {
      assert.equal(
        evaluateCronAuth(
          input({ vercelCronHeader: "1", cronSecret: "cron-secret" }),
        ),
        false,
      );
    });

    it("still authorizes a valid secret when CRON_SECRET is configured", () => {
      assert.equal(
        evaluateCronAuth(
          input({
            vercelCronHeader: "1",
            cronSecret: "cron-secret",
            bearerToken: "cron-secret",
          }),
        ),
        true,
      );
    });

    it("ignores a header value other than '1'", () => {
      assert.equal(
        evaluateCronAuth(input({ vercelCronHeader: "true" })),
        false,
      );
    });
  });

  it("constant-time compare tolerates differing token lengths", () => {
    assert.equal(
      evaluateCronAuth(
        input({ adminToken: "short", bearerToken: "a-much-longer-token" }),
      ),
      false,
    );
  });
});
