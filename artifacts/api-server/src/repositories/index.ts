// Punto único de acceso a la capa de persistencia. Los handlers de rutas
// importan `repos` desde aquí, lo que permite sustituir toda la capa por un
// stub in-memory con un único vi.mock("../repositories") en los tests HTTP.
import * as activity from "./activity.repo";
import * as auditEvents from "./audit-events.repo";
import * as compliance from "./compliance.repo";
import * as dashboard from "./dashboard.repo";
import * as findings from "./findings.repo";
import * as masking from "./masking.repo";
import * as memberships from "./memberships.repo";
import * as invitations from "./invitations.repo";
import * as organizations from "./organizations.repo";
import * as rateLimits from "./rate-limits.repo";
import * as reports from "./reports.repo";
import * as rules from "./rules.repo";
import * as scans from "./scans.repo";
import * as scanSchedules from "./scan-schedules.repo";
import * as sessions from "./sessions.repo";
import * as sources from "./sources.repo";
import * as userRoles from "./user-roles.repo";
import * as users from "./users.repo";

export const repos = {
  activity,
  auditEvents,
  compliance,
  dashboard,
  findings,
  invitations,
  masking,
  memberships,
  organizations,
  rateLimits,
  reports,
  rules,
  scans,
  scanSchedules,
  sessions,
  sources,
  userRoles,
  users,
} as const;


export type Repos = typeof repos;

// M21.5 — predicado de scoping estricto por tenant, re-exportado desde el
// barrel para que rutas/tests lo importen de un único punto (junto a los repos).
export { tenantScopeStrict } from "./tenant";
