import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_BUNDLE_ID,
  buildExportOptions,
  validateBuildNumber,
  validateEnvironment,
  validateMarketingVersion,
  validateProfile,
} from "./ios_testflight.mjs";

const teamId = "W5M6Q4SAV7";
const environment = {
  IOS_CERTIFICATE_BASE64: "dGVzdA==",
  IOS_CERTIFICATE_PASSWORD: "secret",
  IOS_APP_PROFILE_BASE64: "dGVzdA==",
  APPLE_TEAM_ID: teamId,
  ASC_KEY_ID: "AB12CD34EF",
  ASC_ISSUER_ID: "12345678-1234-1234-1234-123456789abc",
  ASC_PRIVATE_KEY_BASE64: "dGVzdA==",
  IOS_MARKETING_VERSION: "1.0",
  IOS_BUILD_NUMBER: "1",
};

function appStoreProfile(overrides = {}) {
  return {
    Name: "miniQ App Store",
    UUID: "12345678-1234-1234-1234-123456789abc",
    TeamIdentifier: [teamId],
    ExpirationDate: "2030-01-01T00:00:00Z",
    Entitlements: {
      "application-identifier": `${teamId}.${APP_BUNDLE_ID}`,
      "com.apple.developer.team-identifier": teamId,
      "get-task-allow": false,
      "beta-reports-active": true,
    },
    ...overrides,
  };
}

test("accepts App Store version and positive integer build number", () => {
  assert.equal(validateMarketingVersion("1.0"), "1.0");
  assert.equal(validateMarketingVersion("1.2.3"), "1.2.3");
  assert.equal(validateBuildNumber("42"), "42");
});

test("rejects malformed versions and build numbers", () => {
  for (const version of ["", "1", "01.0", "1.0.0.0", "v1.0", "1.0-beta"]) {
    assert.throws(() => validateMarketingVersion(version));
  }
  for (const build of ["", "0", "01", "1.2", "-1", "2147483648"]) {
    assert.throws(() => validateBuildNumber(build));
  }
});

test("reports each missing or malformed workflow secret", () => {
  for (const name of Object.keys(environment).filter((name) => !name.startsWith("IOS_MARKETING") && !name.startsWith("IOS_BUILD"))) {
    assert.throws(() => validateEnvironment({ ...environment, [name]: "" }), new RegExp(name));
  }
  assert.throws(() => validateEnvironment({ ...environment, IOS_CERTIFICATE_BASE64: "not base64" }), /Base64/);
  assert.throws(() => validateEnvironment({ ...environment, APPLE_TEAM_ID: "short" }), /APPLE_TEAM_ID/);
});

test("accepts only a live App Store profile for this bundle and team", () => {
  assert.deepEqual(validateProfile(appStoreProfile(), teamId, new Date("2029-01-01")), {
    name: "miniQ App Store",
    uuid: "12345678-1234-1234-1234-123456789abc",
  });
  const invalidProfiles = [
    appStoreProfile({ TeamIdentifier: ["AAAAAAAAAA"] }),
    appStoreProfile({ Entitlements: { ...appStoreProfile().Entitlements, "application-identifier": `${teamId}.wrong` } }),
    appStoreProfile({ Entitlements: { ...appStoreProfile().Entitlements, "get-task-allow": true } }),
    appStoreProfile({ Entitlements: { ...appStoreProfile().Entitlements, "beta-reports-active": false } }),
    appStoreProfile({ ProvisionedDevices: ["device"] }),
    appStoreProfile({ ExpirationDate: "2020-01-01T00:00:00Z" }),
  ];
  for (const profile of invalidProfiles) {
    assert.throws(() => validateProfile(profile, teamId, new Date("2029-01-01")));
  }
});

test("export options use manual App Store Connect signing", () => {
  const plist = buildExportOptions({
    teamId,
    profileName: "miniQ & App Store",
    signingIdentity: "0123456789ABCDEF0123456789ABCDEF01234567",
  });
  assert.match(plist, /<key>method<\/key><string>app-store-connect<\/string>/);
  assert.match(plist, new RegExp(`<key>${APP_BUNDLE_ID.replaceAll(".", "\\.")}<\\/key>`));
  assert.match(plist, /miniQ &amp; App Store/);
  assert.match(plist, /<key>manageAppVersionAndBuildNumber<\/key><false\/>/);
});
