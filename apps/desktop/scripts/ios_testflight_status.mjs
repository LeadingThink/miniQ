import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://api.appstoreconnect.apple.com";
const BUNDLE_ID = "com.leadingthink.miniq";

export function createToken({ keyId, issuerId, privateKey }, now = Date.now()) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("ASC signing key must be an ES256 P-256 key");
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issued = Math.floor(now / 1000);
  const input = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({ iss: issuerId, iat: issued, exp: issued + 600, aud: "appstoreconnect-v1" })}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

// Only allowlisted error fields are logged, never headers or raw bodies.
function diagnosticText(value, credential = "", limit = 512) {
  if (typeof value !== "string") return null;
  let text = credential ? value.split(credential).join("[REDACTED]") : value;
  text = text.replace(/authorization[^\r\n]*/gi, "[REDACTED]")
    .replace(/Bearer\s+[^\s,;"']+/gi, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/[\x00-\x1f\x7f]/g, " ");
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

async function httpFailure(response, url, credential) {
  let errors = [];
  let omitted = 0;
  try {
    const body = await response.json();
    if (Array.isArray(body?.errors)) {
      omitted = Math.max(0, body.errors.length - 5);
      errors = body.errors.slice(0, 5).map((error) => Object.fromEntries(
        ["code", "title", "detail"].map((field) => [field, diagnosticText(error?.[field], credential)]),
      ));
    }
  } catch {
    // Malformed error bodies must not hide the HTTP status or leak content.
  }
  const pathname = diagnosticText(url.pathname, credential);
  const queryNames = [...new Set(url.searchParams.keys())].slice(0, 20)
    .map((name) => diagnosticText(name, credential, 100));
  return new Error("ASC GET " + pathname + " queryNames=" + JSON.stringify(queryNames)
    + " failed: HTTP " + response.status + "; errors=" + JSON.stringify(errors) + "; omittedErrors=" + omitted);
}

export function createAscClient({ token, fetchImpl = fetch, wait = sleep }) {
  async function get(path) {
    const url = new URL(path, API);
    if (url.origin !== API || !url.pathname.startsWith("/v1/")) {
      throw new Error("ASC returned an unsafe pagination URL");
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response;
      let credential;
      try {
        credential = token();
        response = await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
        if (response.ok) return await response.json();
      } catch {
        // Never expose fetch/crypto errors: they may contain credentials or headers.
        if (attempt === 3) throw new Error("ASC request failed after 3 attempts (network, timeout, or invalid response)");
      }
      if (response && !response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 3) throw await httpFailure(response, url, credential);
      }
      await wait(attempt * 2_000);
    }
  }
  return async function list(path) {
    const data = [];
    const included = [];
    const seen = new Set();
    for (let page = 0; path && page < 20; page++) {
      const canonical = new URL(path, API).href;
      if (seen.has(canonical)) throw new Error("ASC pagination repeated a page");
      seen.add(canonical);
      const result = await get(path);
      if (!Array.isArray(result.data)) throw new Error("ASC response is missing resource data");
      data.push(...result.data);
      included.push(...(result.included ?? []));
      path = result.links?.next;
    }
    if (path) throw new Error("ASC pagination exceeded 20 pages; verification incomplete");
    return { data, included };
  };
}

export async function verifyBuild({ list, marketingVersion, buildNumber, wait = sleep, log = console.log, maxPolls = 30, pollMs = 30_000 }) {
  if (!/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(marketingVersion) || !/^[1-9][0-9]*$/.test(buildNumber)) {
    throw new Error("Expected IOS_MARKETING_VERSION and positive integer IOS_BUILD_NUMBER");
  }
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 30 || !Number.isFinite(pollMs) || pollMs < 0 || pollMs > 30_000) {
    throw new Error("Invalid bounded polling configuration");
  }
  log("Upload acceptance does not mean TestFlight installation is available. This check is read-only.");
  const apps = await list(`/v1/apps?${new URLSearchParams({ "filter[bundleId]": BUNDLE_ID, limit: "200" })}`);
  const matches = apps.data.filter((app) => app.attributes?.bundleId === BUNDLE_ID);
  if (matches.length !== 1) throw new Error("Expected exactly one ASC app matching com.leadingthink.miniq");
  const query = new URLSearchParams({ "filter[app]": matches[0].id, "filter[version]": buildNumber, include: "preReleaseVersion,buildBetaDetail", limit: "200" });
  for (let poll = 1; poll <= maxPolls; poll++) {
    const result = await list(`/v1/builds?${query}`);
    const builds = result.data.filter((build) => build.attributes?.version === buildNumber);
    const candidates = builds.filter((build) => {
      const versionId = build.relationships?.preReleaseVersion?.data?.id;
      return result.included.some((version) => version.type === "preReleaseVersions" && version.id === versionId && version.attributes?.version === marketingVersion && version.attributes?.platform === "IOS");
    });
    if (builds.length && !candidates.length) throw new Error("ASC marketing version/platform mismatch or missing preReleaseVersion; verification failed");
    if (candidates.length > 1) throw new Error("ASC returned multiple matching iOS builds; verification failed");
    const build = candidates[0];
    const state = build?.attributes?.processingState ?? "NOT_VISIBLE";
    log(`ASC poll ${poll}/${maxPolls}: ${marketingVersion} (${buildNumber}), processingState=${JSON.stringify(state)}`);
    if (build) {
      const detailsId = build.relationships?.buildBetaDetail?.data?.id;
      const details = result.included.find((resource) => resource.type === "buildBetaDetails" && resource.id === detailsId);
      log(`ASC build attributes (reported values only; null means unavailable): ${JSON.stringify({
        usesNonExemptEncryption: build.attributes?.usesNonExemptEncryption ?? null,
        expired: build.attributes?.expired ?? null,
      })}`);
      log(`ASC buildBetaDetails attributes (not proof of installability; null means unavailable): ${JSON.stringify({
        internalBuildState: details?.attributes?.internalBuildState ?? null,
        externalBuildState: details?.attributes?.externalBuildState ?? null,
      })}`);
      const groups = await list(`/v1/builds/${encodeURIComponent(build.id)}/betaGroups?limit=200`);
      log(`ASC betaGroups relationships: ${JSON.stringify(groups.data.map(({ id, type }) => ({ id, type })))}`);
      if (!groups.data.length) log("::warning::No betaGroups assigned to this build. No group was assigned by this read-only check; the build is not confirmed available to testers.");
    }
    if (state === "FAILED" || state === "INVALID") throw new Error(`ASC build processing ${state}`);
    if (state === "VALID") {
      log("ASC processing VALID. Upload/processing completion is not publication or proof of installability; group access, export compliance and any required Beta App Review must still be checked in App Store Connect.");
      return { buildId: build.id, processingState: state };
    }
    if (state !== "PROCESSING" && state !== "NOT_VISIBLE") throw new Error("ASC returned an unknown processing state");
    if (poll < maxPolls) await wait(pollMs);
  }
  throw new Error("ASC verification timed out; upload may be accepted but processing/installability is unconfirmed. Do not re-upload the same build number.");
}

async function main() {
  const env = process.env;
  for (const name of ["ASC_KEY_ID", "ASC_ISSUER_ID", "IOS_CI_DIR"]) {
    if (!env[name]) throw new Error(`Missing ${name}`);
  }
  let privateKey;
  try {
    privateKey = readFileSync(join(env.IOS_CI_DIR, "AuthKey.p8"), "utf8");
    createToken({ keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID, privateKey });
  } catch {
    throw new Error("Unable to load ASC ES256 signing key from IOS_CI_DIR/AuthKey.p8");
  }
  const token = () => createToken({ keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID, privateKey });
  await verifyBuild({ list: createAscClient({ token }), marketingVersion: env.IOS_MARKETING_VERSION, buildNumber: env.IOS_BUILD_NUMBER });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`ASC verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
