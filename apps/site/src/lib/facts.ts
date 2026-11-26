/*
 * What invincible.sh says as fact, read from this repository when the site is built and never typed out again: the
 * installer and its hash, the Bun it pins, the apps' feeds and requirements, the plan's phases, the README's own line, the
 * licence and the commit. read.ts reads each; a file that doesn't say what the page needs fails the build.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import installer from "../../../../scripts/install.sh?raw";
import pin from "../../../../scripts/bun-pin.sh?raw";
import readme from "../../../../README.md?raw";
import plan from "../../../../docs/PLAN.md?raw";
import pkg from "../../../../package.json?raw";
import appleProject from "../../../apple/project.yml?raw";
import androidBuild from "../../../android/app/build.gradle.kts?raw";
import appcast from "../../public/mac/appcast.xml?raw";
import android from "../../public/android/latest.json?raw";
import { androidVersion, day, megabytes, readAndroid, readAndroidMinSdk, readAppcast, readAppleTargets, readBunPin, readInstaller, readPlan, readTagline } from "./read.ts";

/** The site's own address. */
export const SITE = "https://invincible.sh";

/** The script /install.sh serves, exactly (src/pages/install.sh.ts), and what the page says of it. */
export const INSTALLER = installer;
export const INSTALLER_SHA256 = createHash("sha256").update(installer).digest("hex");
export const INSTALL = readInstaller(installer);
export const BUN_VERSION = readBunPin(pin);

/** Where the source is: the repository the installer installs from. */
export const REPO = `https://github.com/${INSTALL.repo}`;
export const RELEASES = `${REPO}/releases`;
export const doc = (path: string): string => `${REPO}/blob/main/${path}`;

/** What Invincible is, in the README's own words. */
export const TAGLINE = readTagline(readme);
/** The licence, as the repository's package says it. */
export const LICENSE = (() => {
  const id = (JSON.parse(pkg) as { license?: string }).license;
  if (!id) throw new Error("package.json names no licence");
  return id;
})();

/** The plan's phases, each with where it stands. */
export const PHASES = readPlan(plan);

const apple = readAppleTargets(appleProject);
const androidSdk = readAndroidMinSdk(androidBuild);

/** Invincible for Mac, as its update feed offers it (null until its first release), and what it runs on. */
export const MAC = (() => {
  const release = readAppcast(appcast, INSTALL.repo);
  return {
    feed: `${SITE}/mac/appcast.xml`,
    macOS: release?.macOS ?? apple.macOS,
    release: release && { ...release, size: megabytes(release.bytes), day: day(release.date) },
  };
})();

/** Invincible for Android, as apps/android/scripts/publish.sh last published it (null until its first release). */
export const ANDROID = (() => {
  const release = readAndroid(android, INSTALL.repo);
  return {
    feed: `${SITE}/android/latest.json`,
    android: androidVersion(release?.minSdk ?? androidSdk),
    release: release && { ...release, size: megabytes(release.bytes), day: day(release.date) },
  };
})();

/**
 * Invincible for iPhone and iPad: in TestFlight, Apple's beta, which invites testers by the email of their Apple ID. Its
 * public link (testflight.apple.com/join/…) goes here once Apple has reviewed a build for testers outside the team; the
 * download then becomes a button to it. Until then, asking for an invitation is how to be one.
 */
export const IPHONE = {
  iOS: apple.iOS,
  testflight: null as string | null,
  ask: `${REPO}/issues/new?title=${encodeURIComponent("TestFlight invitation")}`,
};

/** The commit the site was built from, for its foot; nothing when it isn't built from a checkout. */
export const COMMIT = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
})();
