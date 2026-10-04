// Stand-in for @privacyresearch/libsignal-protocol-typescript in bundles that run
// signal.ts key setup under node (the real library's curve code can't load there). Keys
// are random bytes: enough to store and publish, no real crypto.
const bytes = (n: number): ArrayBuffer => crypto.getRandomValues(new Uint8Array(n)).buffer;
const keyPair = () => ({ pubKey: bytes(33), privKey: bytes(32) });

export const KeyHelper = {
  generateIdentityKeyPair: async () => keyPair(),
  generateRegistrationId: () => 1234,
  generateSignedPreKey: async (_identity: unknown, keyId: number) => ({ keyId, keyPair: keyPair(), signature: bytes(64) }),
  generatePreKey: async (keyId: number) => ({ keyId, keyPair: keyPair() }),
};

export class SignalProtocolAddress {
  name: string;
  deviceId: number;
  constructor(name: string, deviceId: number) {
    this.name = name;
    this.deviceId = deviceId;
  }
  toString(): string {
    return `${this.name}.${this.deviceId}`;
  }
}

export class SessionBuilder {}
export class SessionCipher {}
