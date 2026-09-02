// Punto único de acceso a la capa de persistencia. Los handlers de rutas
// importan `repos` desde aquí, lo que permite sustituir toda la capa por un
// stub in-memory con un único vi.mock("../repositories") en los tests HTTP.
import * as activity from "./activity.repo";
import * as dashboard from "./dashboard.repo";
import * as findings from "./findings.repo";
import * as reports from "./reports.repo";
import * as rules from "./rules.repo";
import * as scans from "./scans.repo";
import * as sources from "./sources.repo";
import * as userRoles from "./user-roles.repo";
import * as users from "./users.repo";

export const repos = {
  activity,
  dashboard,
  findings,
  reports,
  rules,
  scans,
  sources,
  userRoles,
  users,
} as const;

export type Repos = typeof repos;
