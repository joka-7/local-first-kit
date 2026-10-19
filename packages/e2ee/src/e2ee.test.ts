import { beforeAll, describe, expect, it } from "vitest";
import * as e from "./index";

beforeAll(() => e.ready());

describe("e2ee", () => {
  it("round-trips and rejects wrong key", () => {
    const k = e.generateKey();
    const c = e.encrypt(k, "שלום");
    expect(e.decrypt(k, c)).toBe("שלום");
    expect(() => e.decrypt(e.generateKey(), c)).toThrow();
  });
  it("sealed box only opens with private key", () => {
    const kp = e.generateKeyPair();
    const s = e.sealTo(kp.publicKey, "time off");
    expect(e.openSealed(kp, s)).toBe("time off");
    expect(() => e.openSealed(e.generateKeyPair(), s)).toThrow();
  });
  it("wraps group keys", () => {
    const kp = e.generateKeyPair();
    const gk = e.generateKey();
    expect(e.unwrapKey(kp, e.wrapKey(kp.publicKey, gk))).toEqual(gk);
  });
  it("share link and recovery key round-trip", () => {
    const k = e.generateKey();
    expect(e.parseShareKey(e.buildShareLink("https://x.app/s/1", k))).toEqual(k);
    expect(e.importRecoveryKey(e.exportRecoveryKey(k))).toEqual(k);
  });
});

it("recovery key survives many random keys", () => {
  for (let i = 0; i < 500; i++) {
    const k = e.generateKey();
    expect(e.importRecoveryKey(e.exportRecoveryKey(k))).toEqual(k);
  }
});
