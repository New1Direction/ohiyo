import type { RecoveryCodes, TwoFactorSetup, TwoFactorStatus } from "../../lib/twoFactor";

/** What the card asks the server, so tests can stand in for it. */
export type TwoFactorApi = {
  status: () => Promise<TwoFactorStatus>;
  setup: (password: string) => Promise<TwoFactorSetup>;
  enable: (code: string) => Promise<RecoveryCodes>;
  disable: (password: string, code: string) => Promise<void>;
  newRecoveryCodes: (password: string, code: string) => Promise<RecoveryCodes>;
};

type Props = {
  twoFactorApi: TwoFactorApi;
  username: string;
  onToast: (t: string, type?: "info" | "success" | "error") => void;
  onStatus?: (status: TwoFactorStatus) => void;
};

/** Two-factor sign-in in Settings. Stub: the tests that describe it come first. */
export function TwoFactorCard(_props: Props) {
  return null;
}
