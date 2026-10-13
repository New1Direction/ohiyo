// Stub: the tests in test/helpLinks.test.ts describe what this module must do.
export const TERMS_URL = "";
export const PRIVACY_URL = "";
export const STATUS_URL = "";
export const SUPPORT_EMAIL = "unset";

export type ClientInfo = { version: string; platform: "web" | "desktop"; os: string; browser: string; home: string };

export function describeClient(_ua: string, _desktop: boolean, _version: string, _home: string): ClientInfo {
  return { version: "", platform: "web", os: "", browser: "", home: "" };
}

export function bugReportUrl(_info: ClientInfo): string {
  return "https://example.com/";
}

export function feedbackUrl(_kind: "question" | "idea", _info: ClientInfo): string {
  return "https://example.com/";
}
