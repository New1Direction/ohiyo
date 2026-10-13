// Help & feedback: where people go when something breaks. A bug report opens a public GitHub
// issue, prefilled with what helps (app version, web or desktop, the system and browser, and
// which home), and never with anything private: no path or query from the home address, no
// token, no message text.
//   node --experimental-strip-types --test test/helpLinks.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bugReportUrl,
  describeClient,
  feedbackUrl,
  PRIVACY_URL,
  STATUS_URL,
  SUPPORT_EMAIL,
  TERMS_URL,
} from "../src/lib/helpLinks.ts";

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

test("the client is described by its system and browser, not its full user agent", () => {
  assert.deepEqual(describeClient(MAC_CHROME, false, "0.3.1", "https://api.example.com"), {
    version: "0.3.1",
    platform: "web",
    os: "macOS",
    browser: "Chrome",
    home: "https://api.example.com",
  });
  assert.equal(describeClient(IPHONE_SAFARI, false, "0.3.1", "https://a.example").os, "iOS");
  assert.equal(describeClient(IPHONE_SAFARI, false, "0.3.1", "https://a.example").browser, "Safari");
  assert.equal(describeClient(WINDOWS_EDGE, false, "0.3.1", "https://a.example").browser, "Edge");
  assert.equal(describeClient(WINDOWS_EDGE, false, "0.3.1", "https://a.example").os, "Windows");
  assert.equal(describeClient(LINUX_FIREFOX, false, "0.3.1", "https://a.example").browser, "Firefox");
  assert.equal(describeClient(LINUX_FIREFOX, false, "0.3.1", "https://a.example").os, "Linux");
  assert.equal(describeClient(ANDROID_CHROME, false, "0.3.1", "https://a.example").os, "Android");
  const desktop = describeClient(MAC_CHROME, true, "0.3.1", "https://a.example");
  assert.equal(desktop.platform, "desktop");
  assert.equal(desktop.browser, "Desktop app");
});

test("only the home's origin is kept: a path, query or credentials never reach a report", () => {
  const info = describeClient(MAC_CHROME, false, "0.3.1", "https://user:pw@api.example.com/api/v1?token=abc#x");
  assert.equal(info.home, "https://api.example.com");
  assert.equal(describeClient(MAC_CHROME, false, "0.3.1", "not a url").home, "unknown");
});

test("a bug report is a prefilled public issue with the version, platform, system, browser and home", () => {
  const info = describeClient(MAC_CHROME, false, "0.3.1", "https://api.example.com/api/v1?token=secret-token");
  const url = new URL(bugReportUrl(info));
  assert.equal(url.origin + url.pathname, "https://github.com/New1Direction/ohiyo/issues/new");
  assert.equal(url.searchParams.get("labels"), "bug");
  const body = url.searchParams.get("body") ?? "";
  for (const part of ["0.3.1", "web", "macOS", "Chrome", "https://api.example.com"]) {
    assert.ok(body.includes(part), `the report names ${part}`);
  }
  assert.ok(!url.toString().includes("secret-token"), "no token from the home address");
  assert.ok(/public/i.test(body), "the template warns that issues are public");
  assert.ok((url.searchParams.get("title") ?? "").length > 0, "a title to start from");
});

test("questions and ideas open issues with their own labels and the same details", () => {
  const info = describeClient(LINUX_FIREFOX, true, "0.3.1", "https://api.example.com");
  const question = new URL(feedbackUrl("question", info));
  assert.equal(question.searchParams.get("labels"), "question");
  const idea = new URL(feedbackUrl("idea", info));
  assert.equal(idea.searchParams.get("labels"), "enhancement");
  assert.ok((idea.searchParams.get("body") ?? "").includes("0.3.1"));
});

test("the legal and status pages are the public site's, and no contact email shows until one is set", () => {
  assert.equal(TERMS_URL, "https://ohiyo.gg/terms.html");
  assert.equal(PRIVACY_URL, "https://ohiyo.gg/privacy.html");
  assert.equal(STATUS_URL, "https://ohiyo.gg/status.html");
  assert.equal(SUPPORT_EMAIL, "");
});
