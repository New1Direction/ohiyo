// Where Help & feedback sends people. Bug reports and questions are public GitHub issues, so
// they carry only what helps someone reproduce a problem — the app version, web or desktop, the
// system and browser, and the home's origin — never a path, query, token or message text.

export const REPO_URL = "https://github.com/New1Direction/ohiyo";
export const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;
/** GitHub's private vulnerability reporting (see SECURITY.md). */
export const SECURITY_URL = `${REPO_URL}/security/advisories/new`;
export const STATUS_URL = "https://ohiyo.gg/status.html";
export const TERMS_URL = "https://ohiyo.gg/terms.html";
export const PRIVACY_URL = "https://ohiyo.gg/privacy.html";
/** A contact address for the hosted service. Empty until the owner sets one; Help hides it then. */
export const SUPPORT_EMAIL = "";

export type ClientInfo = { version: string; platform: "web" | "desktop"; os: string; browser: string; home: string };

function osOf(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux|X11/.test(ua)) return "Linux";
  return "Other";
}

function browserOf(ua: string): string {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Other";
}

function originOf(home: string): string {
  try {
    return new URL(home).origin;
  } catch {
    return "unknown";
  }
}

/** The details a report needs, from the user agent; never the user agent itself. */
export function describeClient(ua: string, desktop: boolean, version: string, home: string): ClientInfo {
  return {
    version,
    platform: desktop ? "desktop" : "web",
    os: osOf(ua),
    browser: desktop ? "Desktop app" : browserOf(ua),
    home: originOf(home),
  };
}

function footer(info: ClientInfo): string {
  return [
    "---",
    `Ohiyo ${info.version} · ${info.platform} · ${info.os} · ${info.browser}`,
    `Home: ${info.home}`,
    "",
    "Issues are public: please don't paste passwords, recovery codes or private messages here.",
  ].join("\n");
}

function issueUrl(label: string, title: string, body: string): string {
  const params = new URLSearchParams({ labels: label, title, body });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}

/** A prefilled public bug report. */
export function bugReportUrl(info: ClientInfo): string {
  const body = [
    "**What happened?**",
    "",
    "",
    "**What did you expect to happen?**",
    "",
    "",
    "**Steps to make it happen again**",
    "1. ",
    "",
    footer(info),
  ].join("\n");
  return issueUrl("bug", "Bug: ", body);
}

/** A prefilled question or idea. */
export function feedbackUrl(kind: "question" | "idea", info: ClientInfo): string {
  const body =
    kind === "question"
      ? ["**Your question**", "", "", footer(info)].join("\n")
      : ["**Your idea**", "", "", "**What would it help you do?**", "", "", footer(info)].join("\n");
  return issueUrl(kind === "question" ? "question" : "enhancement", kind === "question" ? "Question: " : "Idea: ", body);
}
