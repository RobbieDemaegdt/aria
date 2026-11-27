import { describe, expect, it } from "vitest";
import { secretRecord, secretValue, type SecretCipher, type SecretSlots } from "../src/main/secret-settings";

/** Decrypts only what the current key encrypted, like DPAPI after a profile change or a locked keyring. */
function setup() {
  const stored = new Map<string, string>();
  const state = { key: "k1", available: true, encryptFails: false };
  const cipher: SecretCipher = {
    isEncryptionAvailable: () => state.available,
    encryptString(text) {
      if (state.encryptFails) throw new Error("encrypt failed");
      return Buffer.from(`${state.key}:${text}`);
    },
    decryptString(data) {
      const text = data.toString();
      if (!text.startsWith(`${state.key}:`)) throw new Error("wrong key");
      return text.slice(state.key.length + 1);
    },
  };
  const slots: SecretSlots = {
    get: (key) => stored.get(key),
    set: (key, value) => {
      if (value === null) stored.delete(key);
      else stored.set(key, value);
    },
  };
  return { stored, state, cipher, slots };
}

type Secrets = Record<string, string>;

describe("secretValue", () => {
  it("stores, reads and removes a value", () => {
    const { cipher, slots, stored } = setup();
    const value = secretValue(cipher, slots, "token", "the token");
    expect(value.has()).toBe(false);
    expect(value.read()).toBeUndefined();
    value.write("abc");
    expect(value.has()).toBe(true);
    expect(value.read()).toBe("abc");
    expect(stored.get("token")).not.toContain("abc");
    value.write(null);
    expect(value.has()).toBe(false);
    expect(stored.size).toBe(0);
  });

  it("says it's stored but gives nothing when it won't decrypt", () => {
    const { cipher, slots, state } = setup();
    const value = secretValue(cipher, slots, "token", "the token");
    value.write("abc");
    state.key = "k2";
    expect(value.has()).toBe(true);
    expect(value.read()).toBeUndefined();
  });

  it("refuses without a keychain", () => {
    const { cipher, slots, state } = setup();
    const value = secretValue(cipher, slots, "token", "the token");
    value.write("abc");
    state.available = false;
    expect(() => value.read()).toThrow(/isn't available to read the token/);
    expect(() => value.write("def")).toThrow(/isn't available to store the token/);
    state.available = true;
    expect(value.read()).toBe("abc");
  });
});

describe("secretRecord", () => {
  const add = (name: string, secret: string) => (current: Secrets) => ({ ...current, [name]: secret });
  const remove = (name: string) => (current: Secrets) => {
    const next = { ...current };
    delete next[name];
    return next;
  };

  it("stores, reads and removes entries, and clears its slot when the last one goes", () => {
    const { cipher, slots, stored } = setup();
    const record = secretRecord<Secrets>(cipher, slots, "all", "the secrets");
    expect(record.read()).toEqual({});
    record.update(add("a", "1"));
    record.update(add("b", "2"));
    expect(record.read()).toEqual({ a: "1", b: "2" });
    record.update(remove("a"));
    record.update(remove("b"));
    expect(record.read()).toEqual({});
    expect(stored.size).toBe(0);
  });

  it("keeps the other entries when a save follows a failed decrypt", () => {
    const { cipher, slots, state, stored } = setup();
    const warnings: string[] = [];
    const record = secretRecord<Secrets>(cipher, slots, "all", "the secrets", (m) => warnings.push(m));
    record.update(add("a", "1"));
    record.update(add("b", "2"));

    state.key = "k2";
    expect(record.read()).toEqual({});
    record.update(add("c", "3"));
    expect(record.read()).toEqual({ c: "3" });
    expect(stored.has("all.unreadable")).toBe(true);
    expect(warnings.join()).toMatch(/Couldn't decrypt the secrets/);
    expect(warnings.join()).not.toMatch(/k1|"a"/);

    // The first key comes back: what was set aside is there, and nothing was lost by what the other key wrote.
    state.key = "k1";
    expect(record.read()).toEqual({ a: "1", b: "2" });
    record.update(add("d", "4"));
    expect(record.read()).toEqual({ a: "1", b: "2", d: "4" });

    state.key = "k2";
    expect(record.read()).toEqual({ c: "3" });
  });

  it("merges everything back after a passing failure, the newer save winning, and empties the aside", () => {
    const { cipher, slots, stored } = setup();
    const record = secretRecord<Secrets>(cipher, slots, "all", "the secrets");
    record.update(add("a", "old"));
    record.update(add("b", "2"));

    // Decrypting fails but encrypting still works, then both work again under the same key.
    const decrypt = cipher.decryptString.bind(cipher);
    cipher.decryptString = () => {
      throw new Error("locked");
    };
    record.update(add("a", "new"));
    cipher.decryptString = decrypt;

    expect(record.read()).toEqual({ a: "new", b: "2" });
    expect(stored.has("all.unreadable")).toBe(true);
    record.update((current) => current);
    expect(record.read()).toEqual({ a: "new", b: "2" });
    expect(stored.has("all.unreadable")).toBe(false);
  });

  it("keeps blobs from two lost keys", () => {
    const { cipher, slots, state } = setup();
    const record = secretRecord<Secrets>(cipher, slots, "all", "the secrets");
    record.update(add("a", "1"));
    state.key = "k2";
    record.update(add("b", "2"));
    state.key = "k3";
    record.update(add("c", "3"));
    expect(record.read()).toEqual({ c: "3" });
    state.key = "k1";
    expect(record.read()).toEqual({ a: "1" });
    state.key = "k2";
    expect(record.read()).toEqual({ b: "2" });
  });

  it("keeps what's set aside when the last readable entry is removed", () => {
    const { cipher, slots, state, stored } = setup();
    const record = secretRecord<Secrets>(cipher, slots, "all", "the secrets");
    record.update(add("a", "1"));
    state.key = "k2";
    record.update(add("b", "2"));
    record.update(remove("b"));
    expect(stored.has("all")).toBe(false);
    expect(stored.has("all.unreadable")).toBe(true);
    state.key = "k1";
    expect(record.read()).toEqual({ a: "1" });
  });

  it("changes nothing when the new value can't be encrypted", () => {
    const { cipher, slots, state, stored } = setup();
    const record = secretRecord<Secrets>(cipher, slots, "all", "the secrets");
    record.update(add("a", "1"));
    const before = [...stored];
    state.key = "k2";
    state.encryptFails = true;
    expect(() => record.update(add("b", "2"))).toThrow(/encrypt failed/);
    expect([...stored]).toEqual(before);
  });

  it("refuses without a keychain, and leaves everything in place", () => {
    const { cipher, slots, state, stored } = setup();
    const record = secretRecord<Secrets>(cipher, slots, "all", "the secrets");
    record.update(add("a", "1"));
    const before = [...stored];
    state.available = false;
    expect(() => record.read()).toThrow(/isn't available to read the secrets/);
    expect(() => record.update(add("b", "2"))).toThrow(/isn't available to read the secrets/);
    expect([...stored]).toEqual(before);
  });

  it("needs no keychain while nothing is stored, except to store something", () => {
    const { cipher, slots, state } = setup();
    state.available = false;
    const record = secretRecord<Secrets>(cipher, slots, "all", "the secrets");
    expect(record.read()).toEqual({});
    expect(() => record.update((current) => current)).not.toThrow();
    expect(() => record.update(add("a", "1"))).toThrow(/isn't available to store the secrets/);
  });

  it("treats a blob that decrypts to something else as unreadable, and keeps it", () => {
    const { cipher, slots, stored } = setup();
    stored.set("all", cipher.encryptString("[1,2]").toString("base64"));
    const record = secretRecord<Secrets>(cipher, slots, "all", "the secrets");
    expect(record.read()).toEqual({});
    record.update(add("a", "1"));
    expect(record.read()).toEqual({ a: "1" });
    expect(stored.has("all.unreadable")).toBe(true);
  });
});
