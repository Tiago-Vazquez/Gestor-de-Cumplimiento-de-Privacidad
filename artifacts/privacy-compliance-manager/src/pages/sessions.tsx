import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAuthListSessions,
  useAuthRevokeSession,
  useAuthLogoutAll,
  getAuthListSessionsQueryKey,
  type SessionSummary,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("es-ES");
}

export default function SessionsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false);

  const { data, isLoading, isError } = useAuthListSessions();
  const revoke = useAuthRevokeSession();
  const logoutAll = useAuthLogoutAll();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getAuthListSessionsQueryKey() });

  const onRevokeSuccess = async () => {
    setConfirmRevoke(null);
    toast({ title: "Sesión revocada", description: "La sesión fue cerrada correctamente." });
    await invalidate();
  };
  const onRevokeError = () => {
    toast({ title: "Error", description: "No se pudo revocar la sesión.", variant: "destructive" });
  };
  const onLogoutAllSuccess = async (result: { revoked?: number } | undefined) => {
    setConfirmLogoutAll(false);
    toast({
      title: "Sesiones cerradas",
      description: `Se revocaron ${result?.revoked ?? 0} sesiones.`,
    });
    await invalidate();
  };
  const onLogoutAllError = () => {
    toast({ title: "Error", description: "No se pudieron cerrar las sesiones.", variant: "destructive" });
  };

  if (isLoading) {
    return (
      <div className="p-6" data-testid="sessions-loading">
        Cargando sesiones…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6" data-testid="sessions-error">
        No se pudieron cargar las sesiones.
        <Button variant="outline" className="ml-3" data-testid="button-retry-sessions" onClick={() => invalidate()}>
          Reintentar
        </Button>
      </div>
    );
  }

  const sessions = data.sessions ?? [];
  const others = sessions.filter((s) => !s.current);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="sessions-title">
            Sesiones
          </h1>
          <p className="text-sm text-muted-foreground">Dispositivos y sesiones activas de tu cuenta.</p>
        </div>
        {others.length > 0 && (
          <Button
            variant="destructive"
            data-testid="button-logout-all"
            disabled={logoutAll.isPending}
            onClick={() => setConfirmLogoutAll(true)}
          >
            {logoutAll.isPending ? "Cerrando…" : "Cerrar todas las demás sesiones"}
          </Button>
        )}
      </div>

      {sessions.length === 0 ? (
        <p data-testid="sessions-empty">No hay sesiones activas.</p>
      ) : (
        <div className="grid gap-4" data-testid="sessions-list">
          {sessions.map((session) => (
            <SessionCard
              key={session.jti}
              session={session}
              confirming={confirmRevoke === session.jti}
              revoking={revoke.isPending}
              onAskRevoke={() => setConfirmRevoke(session.jti)}
              onConfirmRevoke={() =>
                revoke.mutate(
                  { jti: session.jti },
                  { onSuccess: onRevokeSuccess, onError: onRevokeError },
                )
              }
              onCancelRevoke={() => setConfirmRevoke(null)}
            />
          ))}
        </div>
      )}

      {confirmLogoutAll && (
        <Card data-testid="confirm-logout-all">
          <CardHeader>
            <CardTitle>¿Cerrar todas las demás sesiones?</CardTitle>
            <CardDescription>
              Se revocarán {others.length} sesiones. Tu sesión actual permanecerá activa.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button
              variant="destructive"
              data-testid="button-confirm-logout-all"
              disabled={logoutAll.isPending}
              onClick={() => logoutAll.mutate(undefined, { onSuccess: onLogoutAllSuccess, onError: onLogoutAllError })}
            >
              Confirmar
            </Button>
            <Button variant="outline" data-testid="button-cancel-logout-all" onClick={() => setConfirmLogoutAll(false)}>
              Cancelar
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface SessionCardProps {
  session: SessionSummary;
  confirming: boolean;
  revoking: boolean;
  onAskRevoke: () => void;
  onConfirmRevoke: () => void;
  onCancelRevoke: () => void;
}

function SessionCard({
  session,
  confirming,
  revoking,
  onAskRevoke,
  onConfirmRevoke,
  onCancelRevoke,
}: SessionCardProps) {
  return (
    <Card data-testid={`session-card-${session.jti}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="font-mono text-sm" data-testid={`session-jti-${session.jti}`}>
            {session.jti.slice(0, 8)}…
          </span>
          {session.current && (
            <Badge data-testid={`session-current-${session.jti}`}>Actual</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {`Creada: ${formatDateTime(session.createdAt)} · Expira: ${formatDateTime(session.expiresAt)}`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!session.current && !confirming && (
          <Button
            variant="destructive"
            size="sm"
            data-testid={`button-revoke-${session.jti}`}
            disabled={revoking}
            onClick={onAskRevoke}
          >
            {revoking ? "Revocando…" : "Revocar"}
          </Button>
        )}
        {confirming && (
          <div className="flex items-center gap-2" data-testid={`confirm-revoke-${session.jti}`}>
            <p className="text-sm">¿Revocar esta sesión?</p>
            <Button
              variant="destructive"
              size="sm"
              data-testid={`button-confirm-revoke-${session.jti}`}
              disabled={revoking}
              onClick={onConfirmRevoke}
            >
              Confirmar
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid={`button-cancel-revoke-${session.jti}`}
              onClick={onCancelRevoke}
            >
              Cancelar
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}