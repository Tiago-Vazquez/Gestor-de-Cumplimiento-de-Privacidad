import type { Request, Response } from "express";
import { vi } from "vitest";
import { hashPassword } from "@workspace/auth";
import type { MockState } from "./mock-repos";

export interface MockResponse extends Response {
  statusCode: number;
  body: unknown;
}

export function createMockRequest(
  originalUrl = "/api/test",
  method = "GET",
): Request {
  return {
    originalUrl,
    path: originalUrl.split("?")[0],
    method,
    id: "req-test",
  } as unknown as Request;
}

export function createMockResponse(): MockResponse {
  const state = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
  };

  const handlers = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    set() {
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  };

  return {
    ...handlers,
    get headersSent() {
      return state.headersSent;
    },
    set headersSent(value: boolean) {
      state.headersSent = value;
    },
    get statusCode() {
      return state.statusCode;
    },
    get body() {
      return state.body;
    },
  } as unknown as MockResponse;
}

/**
 * M11.1 — Obtiene el token CSRF de synchronizer de una sesión (cookie) mediante
 * `GET /api/csrf-token`. Usado por los tests HTTP que mutan con cookie: tras el
 * login obtienen el token y lo envían en el header `X-CSRF-Token`.
 */
export async function fetchCsrfToken(
  server: ReturnType<import("express").Express["listen"]>,
  cookie: string,
): Promise<string> {
  const request = (await import("supertest")).default;
  const res = await request(server).get("/api/csrf-token").set("Cookie", cookie);
  if (res.status !== 200 || typeof res.body?.csrfToken !== "string") {
    throw new Error("csrf-token endpoint did not return a token");
  }
  return res.body.csrfToken as string;
}

/**
 * M22 (P0-2) — reemplaza al bootstrap legacy en los tests HTTP.
 *
 * Siembra directamente el estado mock con el equivalente de lo que antes hacía
 * `POST /api/auth/login { token }` (identidad fija `bootstrap-admin`): un
 * usuario admin local (con hash scrypt real), rol GLOBAL `admin`, organización
 * inicial y membership `owner`. Después el test inicia sesión por el flujo
 * local (email + password), idéntico al provisioning de producción.
 */
export const TEST_ADMIN_EMAIL = "admin@test.local";
export const TEST_ADMIN_PASSWORD = "secure-password-123";
export const TEST_ADMIN_SUB = "admin-provisioned";
export const TEST_ORG_ID = "org-bootstrap";

export async function seedProvisionedAdmin(
  state: MockState,
  opts: { email?: string; sub?: string; orgId?: string } = {},
): Promise<void> {
  const email = opts.email ?? TEST_ADMIN_EMAIL;
  const sub = opts.sub ?? TEST_ADMIN_SUB;
  const orgId = opts.orgId ?? TEST_ORG_ID;

  // 1. Usuario admin (crear si no existe; conserva el hash si ya existe).
  if (!state.users.some((u) => u.sub === sub)) {
    const passwordHash = await hashPassword(TEST_ADMIN_PASSWORD);
    state.users.push({
      sub,
      email,
      name: "Provisioned Admin",
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null,
    });
  }

  // 2. Rol global `admin` (re-afirmado, idempotente): espejo del `addRole`
  //    que ejecutaba el bootstrap en cada login.
  if (!state.userRoles.some((r) => r.userSub === sub && r.role === "admin")) {
    state.userRoles.push({ userSub: sub, role: "admin", createdAt: new Date() });
  }

  // 3. Organización inicial (idempotente).
  const orgs = (state.organizations ??= []);
  if (!orgs.some((o) => o.id === orgId)) {
    orgs.push({
      id: orgId,
      name: "Test Organization",
      slug: orgId.replace(/^org-/, ""),
      status: "active",
      createdAt: new Date(),
    });
  }

  // 4. Membership `owner` (idempotente).
  const memberships = (state.memberships ??= []);
  if (!memberships.some((m) => m.organizationId === orgId && m.userSub === sub)) {
    memberships.push({
      organizationId: orgId,
      userSub: sub,
      role: "owner",
      invitedBy: null,
      joinedAt: new Date(),
    });
  }
}
