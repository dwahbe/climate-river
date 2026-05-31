import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isPrivateOrReservedIp,
  isBlockedHostname,
  assertPublicHttpUrl,
  safeFetch,
  SsrfError,
} from "../urlSafety";

describe("isPrivateOrReservedIp", () => {
  const blocked = [
    "127.0.0.1",
    "10.0.0.5",
    "10.255.255.255",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1", // multicast
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback (dotted form)
    "::ffff:7f00:1", // IPv4-mapped loopback (hex form, as new URL() canonicalizes)
    "::ffff:a9fe:a9fe", // IPv4-mapped 169.254.169.254 metadata (hex form)
    "::ffff:0a00:0001", // IPv4-mapped 10.0.0.1 (hex form)
    "2001:db8::1",
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => assert.equal(isPrivateOrReservedIp(ip), true));
  }

  const allowed = [
    "8.8.8.8",
    "93.184.216.34",
    "1.1.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
  ];
  for (const ip of allowed) {
    it(`allows public ${ip}`, () =>
      assert.equal(isPrivateOrReservedIp(ip), false));
  }
});

describe("isBlockedHostname", () => {
  for (const h of [
    "localhost",
    "foo.localhost",
    "svc.local",
    "db.internal",
    "metadata.google.internal",
    "169.254.169.254",
    "[::1]",
    "10.0.0.1",
  ]) {
    it(`blocks ${h}`, () => assert.equal(isBlockedHostname(h), true));
  }
  for (const h of ["example.com", "www.reuters.com", "sub.nytimes.com"]) {
    it(`allows ${h}`, () => assert.equal(isBlockedHostname(h), false));
  }
});

describe("assertPublicHttpUrl", () => {
  it("returns a URL for a normal https link", () => {
    assert.equal(
      assertPublicHttpUrl("https://example.com/a").hostname,
      "example.com",
    );
  });

  it("rejects non-http(s) schemes", () => {
    assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), SsrfError);
    assert.throws(() => assertPublicHttpUrl("ftp://example.com"), SsrfError);
  });

  it("rejects blocked hosts and literal private IPs", () => {
    assert.throws(
      () => assertPublicHttpUrl("http://localhost/admin"),
      SsrfError,
    );
    assert.throws(
      () => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/"),
      SsrfError,
    );
  });

  it("rejects a bracketed IPv4-mapped IPv6 metadata literal (canonicalized to hex)", () => {
    // new URL() rewrites the hostname to [::ffff:a9fe:a9fe]; the guard must
    // still recognize it as 169.254.169.254.
    assert.throws(
      () =>
        assertPublicHttpUrl(
          "http://[::ffff:169.254.169.254]/latest/meta-data/",
        ),
      SsrfError,
    );
  });

  it("rejects malformed URLs", () => {
    assert.throws(() => assertPublicHttpUrl("not a url"), SsrfError);
  });
});

describe("safeFetch", () => {
  const publicResolver = async () => ["93.184.216.34"];

  it("fetches a public URL that resolves to a public IP", async () => {
    let called = "";
    const res = await safeFetch(
      "https://example.com/article",
      {},
      {
        resolveHost: publicResolver,
        fetchImpl: (async (input: string) => {
          called = String(input);
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(res.status, 200);
    assert.equal(called, "https://example.com/article");
  });

  it("blocks when a hostname resolves to a private IP", async () => {
    await assert.rejects(
      () =>
        safeFetch(
          "https://internal.example.com/",
          {},
          {
            resolveHost: async () => ["10.1.2.3"],
            fetchImpl: (async () =>
              new Response("ok", { status: 200 })) as unknown as typeof fetch,
          },
        ),
      SsrfError,
    );
  });

  it("re-validates redirect hops and blocks a redirect to a private literal IP", async () => {
    const fetchImpl = (async (input: string) => {
      if (String(input).includes("example.com")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/" },
        });
      }
      return new Response("should-not-reach", { status: 200 });
    }) as unknown as typeof fetch;

    await assert.rejects(
      () =>
        safeFetch(
          "https://example.com/start",
          {},
          { resolveHost: publicResolver, fetchImpl },
        ),
      SsrfError,
    );
  });

  it("blocks a redirect to a hostname that resolves to a private IP", async () => {
    const fetchImpl = (async (input: string) => {
      if (String(input).includes("start")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil-internal.example/" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const resolveHost = async (host: string) =>
      host === "evil-internal.example" ? ["192.168.0.9"] : ["93.184.216.34"];

    await assert.rejects(
      () =>
        safeFetch("https://safe.example/start", {}, { resolveHost, fetchImpl }),
      SsrfError,
    );
  });

  it("throws after exceeding the redirect budget", async () => {
    const fetchImpl = (async (_input: string, init?: RequestInit) => {
      void init;
      return new Response(null, {
        status: 302,
        headers: { location: "https://example.com/loop" },
      });
    }) as unknown as typeof fetch;

    await assert.rejects(
      () =>
        safeFetch(
          "https://example.com/loop",
          {},
          { resolveHost: publicResolver, fetchImpl, maxRedirects: 2 },
        ),
      SsrfError,
    );
  });

  it("throws a non-SsrfError (transient) on DNS resolution failure", async () => {
    let err: unknown;
    try {
      await safeFetch(
        "https://flaky.example/x",
        {},
        {
          resolveHost: async () => {
            throw new Error("ETIMEDOUT");
          },
          fetchImpl: (async () =>
            new Response("x", { status: 200 })) as unknown as typeof fetch,
        },
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error);
    // Must NOT be an SsrfError, so callers can apply benefit-of-the-doubt.
    assert.equal(err instanceof SsrfError, false);
  });

  it("rejects a disallowed scheme before fetching", async () => {
    let fetched = false;
    await assert.rejects(
      () =>
        safeFetch(
          "file:///etc/passwd",
          {},
          {
            resolveHost: publicResolver,
            fetchImpl: (async () => {
              fetched = true;
              return new Response("x");
            }) as unknown as typeof fetch,
          },
        ),
      SsrfError,
    );
    assert.equal(fetched, false);
  });
});
