// Two-factor sign-in in the app. Stub: the tests that describe it come first.

export type TwoFactorChallenge = { two_factor_required: true; challenge: string; expires_in?: number };
export type TwoFactorStatus = { enabled: boolean; available: boolean; recovery_codes_left: number };
export type TwoFactorSetup = { secret: string; otpauth_url: string };
export type RecoveryCodes = { recovery_codes: string[] };

export function isTwoFactorChallenge(_res: unknown): _res is TwoFactorChallenge {
  return false;
}

export function codeKind(_typed: string): "totp" | "recovery" | null {
  return null;
}

export function recoveryCodesText(_codes: string[], _username: string, _when: Date): string {
  return "";
}

export function signInCodeMessage(_err: unknown): string {
  return "";
}

export function stepUpCodeMessage(_err: unknown): string | null {
  return null;
}

export function shouldAnnounceTwoFactorChange(_changedHereAt: number | null, _now: number): boolean {
  return false;
}

export function markTwoFactorChangedHere(): void {}

export function twoFactorChangedHereAt(): number | null {
  return null;
}
