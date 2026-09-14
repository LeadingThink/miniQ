import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const APP_BUNDLE_ID = "com.leadingthink.miniq";

const REQUIRED_SECRETS = [
  "IOS_CERTIFICATE_BASE64",
  "IOS_CERTIFICATE_PASSWORD",
  "IOS_APP_PROFILE_BASE64",
  "APPLE_TEAM_ID",
  "ASC_KEY_ID",
  "ASC_ISSUER_ID",
  "ASC_PRIVATE_KEY_BASE64",
];

export function validateMarketingVersion(value) {
  if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){1,2}$/.test(value ?? "")) {
    throw new Error("marketing_version must contain two or three dot-separated integers, for example 1.0");
  }
  return value;
}

export function validateBuildNumber(value) {
  if (!/^[1-9]\d*$/.test(value ?? "") || BigInt(value) > 2147483647n) {
    throw new Error("build_number must be an integer from 1 through 2147483647");
  }
  return value;
}

function requireEnvironment(environment, names = REQUIRED_SECRETS) {
  const missing = names.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`missing GitHub Actions secrets: ${missing.join(", ")}`);
  }
}

function validateBase64(name, value) {
  const compact = value.replace(/\s/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error(`${name} must contain valid Base64 data`);
  }
  return compact;
}

export function validateEnvironment(environment) {
  requireEnvironment(environment);
  validateMarketingVersion(environment.IOS_MARKETING_VERSION);
  validateBuildNumber(environment.IOS_BUILD_NUMBER);
  validateBase64("IOS_CERTIFICATE_BASE64", environment.IOS_CERTIFICATE_BASE64);
  validateBase64("IOS_APP_PROFILE_BASE64", environment.IOS_APP_PROFILE_BASE64);
  validateBase64("ASC_PRIVATE_KEY_BASE64", environment.ASC_PRIVATE_KEY_BASE64);
  if (!/^[A-Z0-9]{10}$/.test(environment.APPLE_TEAM_ID)) {
    throw new Error("APPLE_TEAM_ID must be a 10-character Apple team identifier");
  }
  if (!/^[A-Z0-9]{10}$/.test(environment.ASC_KEY_ID)) {
    throw new Error("ASC_KEY_ID must be a 10-character App Store Connect key identifier");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(environment.ASC_ISSUER_ID)) {
    throw new Error("ASC_ISSUER_ID must be an App Store Connect issuer UUID");
  }
}

export function validateSource(desktopDirectory) {
  const capacitor = readFileSync(resolve(desktopDirectory, "capacitor.config.ts"), "utf8");
  const project = readFileSync(resolve(desktopDirectory, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");
  if (!capacitor.includes(`appId: "${APP_BUNDLE_ID}"`)) {
    throw new Error(`Capacitor appId must be ${APP_BUNDLE_ID}`);
  }
  const bundleIds = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((match) => match[1]);
  if (bundleIds.length === 0 || bundleIds.some((bundleId) => bundleId !== APP_BUNDLE_ID)) {
    throw new Error(`every iOS target must use bundle identifier ${APP_BUNDLE_ID}`);
  }
}

export function validateProfile(profile, teamId, now = new Date()) {
  const entitlements = profile.Entitlements ?? {};
  const expectedIdentifier = `${teamId}.${APP_BUNDLE_ID}`;
  if (!Array.isArray(profile.TeamIdentifier) || !profile.TeamIdentifier.includes(teamId)) {
    throw new Error("provisioning profile does not belong to APPLE_TEAM_ID");
  }
  if (entitlements["application-identifier"] !== expectedIdentifier) {
    throw new Error(`provisioning profile must authorize ${APP_BUNDLE_ID}`);
  }
  if (entitlements["com.apple.developer.team-identifier"] !== teamId) {
    throw new Error("provisioning profile entitlement has the wrong team identifier");
  }
  if (entitlements["get-task-allow"] !== false || entitlements["beta-reports-active"] !== true) {
    throw new Error("provisioning profile must be an App Store distribution profile");
  }
  if (profile.ProvisionedDevices || profile.ProvisionsAllDevices) {
    throw new Error("development, Ad Hoc, and enterprise profiles cannot upload to TestFlight");
  }
  const expiration = new Date(profile.ExpirationDate);
  if (Number.isNaN(expiration.valueOf()) || expiration <= now) {
    throw new Error("provisioning profile is expired or has an invalid expiration date");
  }
  if (typeof profile.Name !== "string" || profile.Name.length === 0 || /[\r\n]/.test(profile.Name)) {
    throw new Error("provisioning profile has an invalid name");
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(profile.UUID ?? "")) {
    throw new Error("provisioning profile has an invalid UUID");
  }
  return { name: profile.Name, uuid: profile.UUID };
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildExportOptions({ teamId, profileName, signingIdentity }) {
  const values = [teamId, profileName, signingIdentity];
  if (values.some((value) => typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value))) {
    throw new Error("export signing values must be non-empty single-line strings");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key><string>export</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>method</key><string>app-store-connect</string>
  <key>provisioningProfiles</key>
  <dict><key>${APP_BUNDLE_ID}</key><string>${escapeXml(profileName)}</string></dict>
  <key>signingCertificate</key><string>${escapeXml(signingIdentity)}</string>
  <key>signingStyle</key><string>manual</string>
  <key>stripSwiftSymbols</key><true/>
  <key>teamID</key><string>${escapeXml(teamId)}</string>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
`;
}

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required in GitHub Actions");
  appendFileSync(output, `${name}=${value}\n`);
}

function prepareProfile() {
  requireEnvironment(process.env, ["APPLE_TEAM_ID", "IOS_PROFILE_PLIST", "IOS_EXPORT_OPTIONS", "IOS_SIGNING_IDENTITY"]);
  const json = execFileSync(
    "plutil",
    ["-convert", "json", "-o", "-", process.env.IOS_PROFILE_PLIST],
    { encoding: "utf8" },
  );
  const profile = validateProfile(JSON.parse(json), process.env.APPLE_TEAM_ID);
  const options = buildExportOptions({
    teamId: process.env.APPLE_TEAM_ID,
    profileName: profile.name,
    signingIdentity: process.env.IOS_SIGNING_IDENTITY,
  });
  writeFileSync(process.env.IOS_EXPORT_OPTIONS, options, { mode: 0o600 });
  writeOutput("profile_name", profile.name);
  writeOutput("profile_uuid", profile.uuid);
}

function main() {
  const action = process.argv[2];
  if (action === "validate") {
    validateEnvironment(process.env);
    validateSource(resolve(import.meta.dirname, ".."));
    console.log(`Validated miniQ iOS ${process.env.IOS_MARKETING_VERSION} build ${process.env.IOS_BUILD_NUMBER}`);
    return;
  }
  if (action === "prepare-profile") {
    prepareProfile();
    console.log("Validated App Store provisioning profile and created export options");
    return;
  }
  throw new Error("expected action: validate or prepare-profile");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
