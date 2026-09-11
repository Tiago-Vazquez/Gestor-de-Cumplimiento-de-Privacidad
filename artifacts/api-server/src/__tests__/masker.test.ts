import { describe, expect, it } from "vitest";
import {
  MASKABLE_FIELDS,
  deriveMaskerKey,
  maskValue,
  type MaskableField,
} from "../lib/masker";

/** Claves fijas solo para tests (la integración real usa SOURCE_ENCRYPTION_KEY). */
const KEY_A = deriveMaskerKey("test-master-secret-A");
const KEY_B = deriveMaskerKey("test-master-secret-B");

describe("deriveMaskerKey", () => {
  it("es estable: mismo secreto maestro → misma subclave", () => {
    expect(deriveMaskerKey("test-master-secret-A")).toBe(KEY_A);
  });

  it("distingue secretos maestros distintos", () => {
    expect(KEY_A).not.toBe(KEY_B);
  });

  it("expone el catálogo completo de campos soportados (M5.b)", () => {
    expect(MASKABLE_FIELDS).toEqual(["email", "phone", "national_id", "credit_card"]);
  });
});

describe("maskValue — determinismo y consistencia", () => {
  it("mismo valor + misma clave → mismo token (determinismo)", () => {
    for (const field of MASKABLE_FIELDS) {
      const value = { email: "ana@empresa.com", phone: "+54 9 11 5555 4821", national_id: "27.442.918-6", credit_card: "4539 0213 4567 8901" }[field]!;
      expect(maskValue(value, field, KEY_A)).toBe(maskValue(value, field, KEY_A));
      expect(maskValue(value, field, KEY_A)).toBe(maskValue(value, field, KEY_A));
    }
  });

  it("misma clave + valores distintos → tokens distintos", () => {
    expect(maskValue("ana@empresa.com", "email", KEY_A)).not.toBe(maskValue("juan@empresa.com", "email", KEY_A));
    expect(maskValue("+54 9 11 5555 4821", "phone", KEY_A)).not.toBe(maskValue("+34 6 00 1111 2222", "phone", KEY_A));
    expect(maskValue("27.442.918-6", "national_id", KEY_A)).not.toBe(maskValue("20.118.562-9", "national_id", KEY_A));
    expect(maskValue("4539 0213 4567 8901", "credit_card", KEY_A)).not.toBe(maskValue("4539 0213 4567 0000", "credit_card", KEY_A));
  });

  it("mismo valor + claves distintas → tokens distintos (secreto por dominio)", () => {
    expect(maskValue("ana@empresa.com", "email", KEY_A)).not.toBe(maskValue("ana@empresa.com", "email", KEY_B));
    expect(maskValue("27.442.918-6", "national_id", KEY_A)).not.toBe(maskValue("27.442.918-6", "national_id", KEY_B));
  });

  it("mismo valor en campos distintos → tokens distintos (sin correlación entre columnas)", () => {
    const phone = maskValue("27.442.918-6", "phone", KEY_A);
    const nationalId = maskValue("27.442.918-6", "national_id", KEY_A);
    expect(phone).not.toBe(nationalId);
    // Ambos mantienen el mismo patrón de separadores pero con dígitos distintos.
    expect(phone.replace(/[0-9]/g, "")).toBe(nationalId.replace(/[0-9]/g, ""));
  });
});

describe("maskValue — preservación de formato", () => {
  it("email conserva `@dominio` y la longitud del local-part", () => {
    const masked = maskValue("ana.mperez+qa@empresa.com", "email", KEY_A);
    expect(masked).toMatch(/^[a-z0-9][a-z0-9._+-]*@empresa\.com$/);
    expect(masked.split("@")[0]).toHaveLength("ana.mperez+qa".length);
    expect(masked).not.toContain("ana");
  });

  it("email sin @ tokeniza la cadena completa preservando longitud y clase", () => {
    const masked = maskValue("ana.mperez", "email", KEY_A);
    expect(masked).toHaveLength("ana.mperez".length);
    expect(masked).not.toContain("ana");
  });

  it("phone conserva separadores y cantidad de dígitos", () => {
    const input = "+54 9 11 5555 4821";
    const masked = maskValue(input, "phone", KEY_A);
    const digits = (s: string) => s.replace(/[^0-9]/g, "");
    expect(digits(masked)).toHaveLength(digits(input).length);
    expect(masked.replace(/[0-9]/g, "")).toBe(input.replace(/[0-9]/g, ""));
    expect(masked).not.toBe(input);
  });

  it("national_id conserva puntos y guión (formato CUIT)", () => {
    const input = "27.442.918-6";
    const masked = maskValue(input, "national_id", KEY_A);
    expect(masked).toMatch(/^\d{2}\.\d{3}\.\d{3}-\d$/);
    expect(masked).not.toBe(input);
  });

  it("credit_card conserva la separación en grupos de 4 y los 16 dígitos", () => {
    const input = "4539 0213 4567 8901";
    const masked = maskValue(input, "credit_card", KEY_A);
    expect(masked).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/);
    expect(masked.replace(/[^0-9]/g, "")).toHaveLength(16);
    expect(masked).not.toBe(input);
    // Mismo tarjetahabiente (mismos primeros 6 dígitos) NO debe filtrar el BIN real.
    expect(masked.startsWith("4539")).toBe(false);
  });
});

describe("maskValue — casos límite", () => {
  it("valor vacío se devuelve sin cambios", () => {
    for (const field of MASKABLE_FIELDS) {
      expect(maskValue("", field, KEY_A)).toBe("");
    }
  });

  it("phone sin dígitos se devuelve sin cambios (no hay PII numérica que tokenizar)", () => {
    expect(maskValue("desconocido", "phone", KEY_A)).toBe("desconocido");
  });

  it("rechaza campos sin política definida (no se improvisa una estrategia)", () => {
    expect(() => maskValue("Lorem ipsum", "address" as MaskableField, KEY_A)).toThrow(RangeError);
  });

  it("valores de un solo dígito o carácter se tokenizan correctamente", () => {
    for (const field of MASKABLE_FIELDS) {
      const value = { email: "a@b.co", phone: "1", national_id: "1", credit_card: "1" }[field]!;
      const out = maskValue(value, field, KEY_A);
      expect(out).toBeTruthy();
      expect(maskValue(value, field, KEY_A)).toBe(out);
    }
  });
});