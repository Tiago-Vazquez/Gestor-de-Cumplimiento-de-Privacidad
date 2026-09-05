import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@workspace/auth";

describe("Password hashing (scrypt)", () => {
  it("hash generates a value different from the original password", async () => {
    const hash = await hashPassword("my-secure-password-123");
    expect(hash).not.toBe("my-secure-password-123");
  });

  it("same password verifies correctly", async () => {
    const password = "my-secure-password-123";
    const hash = await hashPassword(password);
    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it("incorrect password fails verification", async () => {
    const hash = await hashPassword("my-secure-password-123");
    const isValid = await verifyPassword("wrong-password", hash);
    expect(isValid).toBe(false);
  });

  it("different hashes for same password due to salt", async () => {
    const password = "my-secure-password-123";
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);
    expect(hash1).not.toBe(hash2);
  });

  it("both hashes verify correctly", async () => {
    const password = "my-secure-password-123";
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);
    expect(await verifyPassword(password, hash1)).toBe(true);
    expect(await verifyPassword(password, hash2)).toBe(true);
  });

  it("invalid hash format returns false", async () => {
    const isValid = await verifyPassword("password", "invalid-hash");
    expect(isValid).toBe(false);
  });

  it("empty password returns false on verify", async () => {
    const hash = await hashPassword("my-secure-password-123");
    const isValid = await verifyPassword("", hash);
    expect(isValid).toBe(false);
  });

  it("empty hash returns false on verify", async () => {
    const isValid = await verifyPassword("password", "");
    expect(isValid).toBe(false);
  });

  it("hash contains all required parameters", async () => {
    const hash = await hashPassword("my-secure-password-123");
    const parts = hash.split("$");
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toBe("16384"); // N
    expect(parts[2]).toBe("8"); // r
    expect(parts[3]).toBe("1"); // p
    expect(parts[4]).toBeDefined(); // salt
    expect(parts[5]).toBeDefined(); // hash
  });
});
