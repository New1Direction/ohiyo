import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { api } from "../../src/api";
import { AuthScreen } from "../../src/components/AuthScreen";
import { ChangePassword } from "../../src/components/settings/ChangePassword";
import { TwoFactorCard, type TwoFactorApi } from "../../src/components/settings/TwoFactorCard";
import type { TwoFactorStatus } from "../../src/lib/twoFactor";
export { act };

const SESSION_USER = { id: "u1", username: "alice", display_name: "Alice", avatar_url: null };

function refused(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

/** The sign-in door for an account with two-factor sign-in on: the password step answers
 *  with a challenge and the code step with a session. Calls are recorded, not sent. */
export function mountTwoFactorSignIn(element: HTMLElement) {
  const calls: string[] = [];
  const signedIn: string[] = [];
  (api as { login: unknown }).login = async (username: string, password: string) => {
    calls.push(`login ${username} ${password}`);
    return { two_factor_required: true, challenge: "chal-1", expires_in: 300 };
  };
  (api as { loginTwoFactor: unknown }).loginTwoFactor = async (challenge: string, code: string) => {
    calls.push(`code ${challenge} ${code}`);
    if (code === "000000") throw refused(403, "that code isn't right");
    return { token: "session-token", user: SESSION_USER };
  };
  const home = { id: "test", name: "Ohiyo", url: "http://localhost", token: null };
  const root = createRoot(element);
  act(() =>
    root.render(
      <AuthScreen
        home={home}
        homes={[home]}
        onAuth={(token: string) => {
          signedIn.push(token);
        }}
        onSwitchHome={() => {}}
        onAddHome={() => {}}
      />,
    ),
  );
  return { calls, signedIn, unmount: () => act(() => root.unmount()) };
}

/** The Settings card, backed by an in-memory account, with every call recorded. */
export function mountTwoFactorCard(element: HTMLElement, start: TwoFactorStatus) {
  const calls: string[] = [];
  const changes: boolean[] = [];
  let status = { ...start };
  const codes = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-DD${String.fromCharCode(65 + i)}${String.fromCharCode(66 + i)}`);
  const twoFactorApi: TwoFactorApi = {
    status: async () => {
      calls.push("status");
      return { ...status };
    },
    setup: async (password) => {
      calls.push(`setup ${password}`);
      if (password !== "right-password") throw refused(403, "that isn't your password");
      return { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/Ohiyo%3Aalice?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Ohiyo" };
    },
    enable: async (code) => {
      calls.push(`enable ${code}`);
      if (code !== "123456") throw refused(403, "that code isn't right");
      status = { ...status, enabled: true, recovery_codes_left: 10 };
      return { recovery_codes: codes };
    },
    disable: async (password, code) => {
      calls.push(`disable ${password} ${code}`);
      status = { ...status, enabled: false, recovery_codes_left: 0 };
    },
    newRecoveryCodes: async (password, code) => {
      calls.push(`codes ${password} ${code}`);
      return { recovery_codes: codes };
    },
  };
  const root = createRoot(element);
  act(() =>
    root.render(
      <TwoFactorCard
        twoFactorApi={twoFactorApi}
        username="alice"
        onToast={() => {}}
        onStatus={(s: TwoFactorStatus) => {
          changes.push(s.enabled);
        }}
      />,
    ),
  );
  /** Another device turns it on or off: the server's answer changes, nothing on screen yet. */
  const changeElsewhere = (enabled: boolean) => {
    status = { ...status, enabled, recovery_codes_left: enabled ? 10 : 0 };
  };
  return { calls, changes, codes, changeElsewhere, unmount: () => act(() => root.unmount()) };
}

/** The Change password card for an account with two-factor sign-in on. `known: false` is
 *  the card before Settings learned that: the server asks for the code instead. */
export function mountChangePasswordWithCode(element: HTMLElement, { known = true }: { known?: boolean } = {}) {
  const sent: unknown[][] = [];
  (api as { changePassword: unknown }).changePassword = async (...args: unknown[]) => {
    sent.push(args);
    if (!args[3]) throw refused(403, "enter the code from your authenticator app");
    return { token: "fresh-token", user: SESSION_USER };
  };
  const root = createRoot(element);
  act(() =>
    root.render(
      <ChangePassword token="t" username="alice" needsCode={known} onToast={() => {}} onChanged={() => {}} />,
    ),
  );
  return { sent, unmount: () => act(() => root.unmount()) };
}
