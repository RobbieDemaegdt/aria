/**
 * Settings encrypted with the OS keychain. A blob that won't decrypt today may decrypt tomorrow (a locked keyring, a
 * restored profile), so a save never overwrites one holding other secrets: it's set aside until it can be read again.
 * Pure (no Electron), so its unit test holds it to that.
 */

/** What Electron's `safeStorage` gives, and all that's used of it. */
export type SecretCipher = {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
};

/** Where the encrypted text is kept. */
export type SecretSlots = {
  get(key: string): string | undefined;
  set(key: string, value: string | null): void;
};

export type SecretValue = {
  /** Whether something is stored, readable today or not. */
  has(): boolean;
  /** The stored value, or nothing if there's none or it won't decrypt. Throws without a keychain. */
  read(): string | undefined;
  /** Replaces the value (nothing else lives in this slot), or removes it. Throws without a keychain. */
  write(value: string | null): void;
};

export type SecretRecord<T extends object> = {
  /** Everything that can be read today; empty if nothing can. Throws without a keychain. */
  read(): T;
  /** Saves what `change` makes of `read()`, keeping anything that can't be read today. Throws without a keychain. */
  update(change: (current: T) => T): void;
};

function needKeychain(cipher: SecretCipher, verb: "read" | "store", label: string): void {
  if (!cipher.isEncryptionAvailable()) throw new Error(`OS keychain encryption (safeStorage) isn't available to ${verb} ${label}.`);
}

const encrypt = (cipher: SecretCipher, text: string): string => cipher.encryptString(text).toString("base64");

function decrypt(cipher: SecretCipher, blob: string): string | undefined {
  try {
    return cipher.decryptString(Buffer.from(blob, "base64"));
  } catch {
    return undefined;
  }
}

/** One secret in one slot, such as a single API key. */
export function secretValue(cipher: SecretCipher, slots: SecretSlots, key: string, label: string): SecretValue {
  return {
    has: () => Boolean(slots.get(key)),
    read() {
      const blob = slots.get(key);
      if (!blob) return undefined;
      needKeychain(cipher, "read", label);
      return decrypt(cipher, blob);
    },
    write(value) {
      if (!value) {
        slots.set(key, null);
        return;
      }
      needKeychain(cipher, "store", label);
      slots.set(key, encrypt(cipher, value));
    },
  };
}

/**
 * Several secrets in one slot, as a JSON object. Blobs that can't be read wait under `<key>.unreadable`, one per line,
 * oldest first, and rejoin the record once they can: what's in the main slot is newer, so it wins.
 */
export function secretRecord<T extends object>(cipher: SecretCipher, slots: SecretSlots, key: string, label: string, warn?: (message: string) => void): SecretRecord<T> {
  const asideKey = `${key}.unreadable`;

  const decode = (blob: string): T | undefined => {
    const text = decrypt(cipher, blob);
    if (text === undefined) return undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : undefined;
    } catch {
      return undefined;
    }
  };

  /** Merges every blob that reads, oldest first, and says which don't. */
  const load = (): { current: T; unreadable: string[] } => {
    const blobs = [...(slots.get(asideKey)?.split("\n") ?? []), slots.get(key)].filter((blob): blob is string => Boolean(blob));
    if (blobs.length > 0) needKeychain(cipher, "read", label);
    let current = {} as T;
    const unreadable: string[] = [];
    for (const blob of blobs) {
      const decoded = decode(blob);
      if (decoded) current = { ...current, ...decoded };
      else if (!unreadable.includes(blob)) unreadable.push(blob);
    }
    return { current, unreadable };
  };

  return {
    read: () => load().current,
    update(change) {
      const { current, unreadable } = load();
      const next = change(current);
      let blob: string | null = null;
      if (Object.keys(next).length > 0) {
        needKeychain(cipher, "store", label);
        blob = encrypt(cipher, JSON.stringify(next));
      }
      // Set aside first: stopped halfway, the main slot still holds what it did.
      if (unreadable.length > 0) warn?.(`Couldn't decrypt ${label}: keeping them aside until the OS keychain can read them.`);
      slots.set(asideKey, unreadable.length > 0 ? unreadable.join("\n") : null);
      slots.set(key, blob);
    },
  };
}
