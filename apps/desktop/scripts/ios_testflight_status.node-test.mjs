import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { createAscClient, createToken, verifyBuild } from "./ios_testflight_status.mjs";

const noWait = async () => {};
function scenario(states, { version = "1.0", groups = [], buildAttributes = {}, betaDetails } = {}) {
  const logs = [];
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(url.origin, "https://api.appstoreconnect.apple.com");
    let body;
    if (url.pathname === "/v1/apps") {
      assert.equal(url.searchParams.get("filter[bundleId]"), "com.leadingthink.miniq");
      body = { data: [{ id: "app-1", attributes: { bundleId: "com.leadingthink.miniq" } }] };
    } else if (url.pathname === "/v1/builds") {
      assert.equal(url.searchParams.get("filter[app]"), "app-1");
      assert.equal(url.searchParams.get("filter[version]"), "42");
      assert.equal(url.searchParams.get("include"), "preReleaseVersion,buildBetaDetail");
      const state = states[Math.min(polls++, states.length - 1)];
      body = state === null ? { data: [] } : {
        data: [{ id: "build-1", attributes: { version: "42", processingState: state, ...buildAttributes }, relationships: { preReleaseVersion: { data: { id: "version-1" } }, buildBetaDetail: { data: { id: "details-1" } } } }],
        included: [{ id: "version-1", type: "preReleaseVersions", attributes: { version, platform: "IOS" } },
          { id: "other-details", type: "buildBetaDetails", attributes: { internalBuildState: "WRONG_BUILD" } },
          ...(betaDetails ? [{ id: "details-1", type: "buildBetaDetails", attributes: betaDetails }] : [])],
      };
    } else {
      assert.equal(url.pathname, "/v1/builds/build-1/betaGroups");
      body = { data: groups };
    }
    return { ok: true, json: async () => body };
  };
  return {
    logs, calls,
    run: () => verifyBuild({ list: createAscClient({ token: () => "test-token", fetchImpl, wait: noWait }), marketingVersion: "1.0", buildNumber: "42", log: (line) => logs.push(line), wait: noWait, maxPolls: 3, pollMs: 0 }),
  };
}

test("ES256 JWT has correct claims, lifetime, and verifiable JOSE signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwt = createToken({ keyId: "test-key", issuerId: "test-issuer", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }, 1_700_000_000_000);
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "ES256", kid: "test-key", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), { iss: "test-issuer", iat: 1_700_000_000, exp: 1_700_000_600, aud: "appstoreconnect-v1" });
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
});

test("pending visibility and processing progress to VALID with unassigned warning", async () => {
  const s = scenario([null, "PROCESSING", "VALID"]);
  assert.deepEqual(await s.run(), { buildId: "build-1", processingState: "VALID" });
  assert.ok(s.logs.some((line) => line.includes("NOT_VISIBLE")));
  assert.ok(s.logs.some((line) => line.startsWith("::warning::No betaGroups")));
  assert.ok(s.logs.some((line) => line.includes("not publication or proof of installability")));
  assert.ok(s.logs.every((line) => !line.includes("test-token")));
});

test("assigned groups are printed without claiming installability", async () => {
  const s = scenario(["VALID"], { groups: [{ id: "group-1", type: "betaGroups" }] });
  await s.run();
  assert.ok(s.logs.some((line) => line.includes('"id":"group-1"')));
  assert.ok(s.logs.every((line) => !line.startsWith("::warning::")));
});

for (const state of ["FAILED", "INVALID"]) {
  test(`${state} processing fails verification`, async () => {
    await assert.rejects(scenario([state]).run(), new RegExp(`processing ${state}`));
  });
}

test("marketing version mismatch fails without accepting a different release", async () => {
  const s = scenario(["VALID"], { version: "2.0" });
  await assert.rejects(s.run(), /marketing version\/platform mismatch/);
  assert.equal(s.calls.length, 2);
});

test("pending processing stops at the polling bound", async () => {
  const s = scenario(["PROCESSING"]);
  await assert.rejects(s.run(), /timed out/);
  assert.equal(s.calls.filter((url) => url.pathname === "/v1/builds").length, 3);
});

for (const status of [429, 500, 503]) {
  test(`HTTP ${status} is retried at most three times`, async () => {
    let calls = 0;
    const list = createAscClient({ token: () => "secret", wait: noWait, fetchImpl: async () => { calls++; return { ok: false, status }; } });
    await assert.rejects(list("/v1/apps"), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 3);
  });
}

test("transient failure recovers and authorization errors do not retry", async () => {
  let calls = 0;
  const recovered = createAscClient({ token: () => "secret", wait: noWait, fetchImpl: async () => ++calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ data: [] }) } });
  assert.deepEqual(await recovered("/v1/apps"), { data: [], included: [] });
  assert.equal(calls, 2);
  calls = 0;
  const unauthorized = createAscClient({ token: () => "secret", wait: noWait, fetchImpl: async () => { calls++; return { ok: false, status: 401 }; } });
  await assert.rejects(unauthorized("/v1/apps"), /HTTP 401/);
  assert.equal(calls, 1);
});

test("network errors are bounded and redact sensitive underlying messages", async () => {
  let calls = 0;
  const list = createAscClient({ token: () => "secret", wait: noWait, fetchImpl: async () => { calls++; throw new Error("secret JWT private key"); } });
  await assert.rejects(list("/v1/apps"), (error) => !/secret|JWT|private key/.test(error.message) && /3 attempts/.test(error.message));
  assert.equal(calls, 3);
});

test("pagination collects all groups and rejects cross-origin credential forwarding", async () => {
  let calls = 0;
  const list = createAscClient({ token: () => "secret", wait: noWait, fetchImpl: async () => ({ ok: true, json: async () => ++calls === 1 ? { data: [{ id: "a" }], links: { next: "/v1/apps?cursor=2" } } : { data: [{ id: "b" }] } }) });
  assert.deepEqual((await list("/v1/apps")).data, [{ id: "a" }, { id: "b" }]);
  await assert.rejects(list("https://example.com/v1/apps"), /unsafe pagination/);
  assert.equal(calls, 2);
});

for (const attributes of [
  { usesNonExemptEncryption: false, expired: true },
  { usesNonExemptEncryption: true, expired: false },
]) {
  test(`reports encryption/expiry ${JSON.stringify(attributes)} and related beta states before VALID`, async () => {
    const betaDetails = { internalBuildState: "IN_BETA_TESTING", externalBuildState: "WAITING_FOR_BETA_REVIEW" };
    const s = scenario(["VALID"], { buildAttributes: attributes, betaDetails });
    await s.run();
    const buildLine = s.logs.findIndex((line) => line.startsWith("ASC build attributes"));
    const detailsLine = s.logs.findIndex((line) => line.startsWith("ASC buildBetaDetails attributes"));
    const validLine = s.logs.findIndex((line) => line.startsWith("ASC processing VALID"));
    assert.ok(buildLine >= 0 && buildLine < validLine);
    assert.ok(detailsLine >= 0 && detailsLine < validLine);
    assert.deepEqual(JSON.parse(s.logs[buildLine].slice(s.logs[buildLine].indexOf("{"))), attributes);
    assert.deepEqual(JSON.parse(s.logs[detailsLine].slice(s.logs[detailsLine].indexOf("{"))), betaDetails);
    assert.match(s.logs[detailsLine], /not proof of installability/);
    assert.ok(s.logs.every((line) => !line.includes("WRONG_BUILD")));
  });
}

test("missing encryption, expiry and beta details are explicitly unavailable", async () => {
  const s = scenario(["VALID"]);
  await s.run();
  assert.ok(s.logs.some((line) => line.includes('"usesNonExemptEncryption":null,"expired":null')));
  assert.ok(s.logs.some((line) => line.includes('"internalBuildState":null,"externalBuildState":null')));
  assert.ok(s.logs.every((line) => !line.includes("WRONG_BUILD")));
});

test("HTTP 400 identifies the failing GET and preserves bounded Apple errors safely", async () => {
  for (const path of ["/v1/apps?filter[bundleId]=hidden-bundle", "/v1/builds?filter[app]=hidden-app&include=hidden-include"]) {
    let calls = 0;
    const list = createAscClient({ token: () => "fake-credential", wait: noWait, fetchImpl: async () => {
      calls++;
      return { ok: false, status: 400, headers: { sensitive: "hidden-header" }, json: async () => ({
        headers: "hidden-body-header",
        errors: [{ code: "PARAMETER_ERROR.INVALID", title: "Invalid include", detail: "buildBetaDetail is required", headers: "hidden-error-header" },
          { code: "fake-credential", title: "Bearer another-credential", detail: "Authorization: hidden-auth\n" + "x".repeat(800) },
          ...Array.from({ length: 6 }, () => ({ code: "LONG", title: "t".repeat(800), detail: "d".repeat(800) }))],
      }) };
    } });
    await assert.rejects(list(path), (error) => {
      assert.match(error.message, /ASC GET \/v1\/(apps|builds) queryNames=/);
      assert.match(error.message, /filter\[(bundleId|app)\]/);
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /PARAMETER_ERROR.INVALID/);
      assert.match(error.message, /buildBetaDetail is required/);
      assert.doesNotMatch(error.message, /fake-credential|another-credential|hidden-|Authorization|Bearer|headers/);
      const errors = JSON.parse(error.message.split("; errors=")[1].split("; omittedErrors=")[0]);
      assert.equal(errors.length, 5);
      assert.match(error.message, /omittedErrors=3$/);
      assert.ok(errors.every((item) => Object.values(item).every((value) => value === null || value.length <= 512)));
      return true;
    });
    assert.equal(calls, 1);
  }
});

for (const body of [null, {}, { errors: "invalid" }, { errors: [null, { code: {} }] }, "not-json"]) {
  test(`malformed HTTP error body is safe: ${JSON.stringify(body)}`, async () => {
    const list = createAscClient({ token: () => "fake", fetchImpl: async () => ({ ok: false, status: 400, json: async () => {
      if (typeof body === "string") throw new Error("hidden raw response");
      return body;
    } }) });
    await assert.rejects(list("/v1/apps"), (error) => /HTTP 400/.test(error.message) && !/hidden raw response/.test(error.message));
  });
}
