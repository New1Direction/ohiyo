// Stub: test/helpTab.test.ts describes what this tab must show.
export type ServiceStatus = { ok: boolean; components?: { name: string; status: string }[] };

export type HelpTabProps = {
  version: string;
  desktop: boolean;
  home: string;
  userAgent: string;
  loadStatus: () => Promise<ServiceStatus>;
};

export function HelpTab(_props: HelpTabProps) {
  return null;
}
