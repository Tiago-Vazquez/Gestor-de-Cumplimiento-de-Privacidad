import { CircleHelp, ShieldCheck, UserCog, Users } from 'lucide-react';
import { useState } from 'react';
import { getListUsersQueryKey, useListUsers, useUpdateUser, useUpdateUserRoles } from '@workspace/api-client-react';
import type { AdminUser } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeading } from '@/components/app-shell';
import { useAuth } from '@/auth/auth-context';

const formatDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** Guardia de UI: la protección real la aplica el backend (requireRole admin). */
function AdminGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user?.roles.includes('admin')) {
    return (
      <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
        <PageHeading eyebrow="Administración" title="Usuarios" />
        <div className="rounded-2xl border border-card-border bg-card p-12 text-center shadow-[var(--shadow-card)]">
          <CircleHelp className="mx-auto mb-3 text-[#bf5a4e]" />
          <p className="font-display font-bold">No tienes permisos de administración.</p>
          <p className="mt-1 text-sm text-muted-foreground">Esta sección requiere el rol admin.</p>
        </div>
      </section>
    );
  }
  return children;
}

export default function UsersPage() {
  return (
    <AdminGate>
      <UsersAdmin />
    </AdminGate>
  );
}

function UsersAdmin() {
  const queryClient = useQueryClient();
  const usersQuery = useListUsers();
  const { user: currentUser } = useAuth();
  const [editing, setEditing] = useState<{ sub: string; email: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });

  const updateUserMutation = useUpdateUser({
    mutation: {
      onSuccess: () => { setEditing(null); setError(null); void invalidate(); },
      onError: (err) => {
        const status = (err as { status?: number }).status;
        setError(status === 409 ? 'Ese email ya está registrado.' : 'No se pudo actualizar el usuario.');
      },
    },
  });

  const updateRolesMutation = useUpdateUserRoles({
    mutation: {
      onSuccess: () => { setError(null); void invalidate(); },
      onError: (err) => {
        const status = (err as { status?: number }).status;
        setError(status === 403 ? 'No puedes retirar el rol al último administrador.' : 'No se pudieron actualizar los roles.');
      },
    },
  });

  const toggleRole = (target: AdminUser, role: 'admin' | 'auditor') => {
    const has = target.roles.includes(role);
    const next = has ? target.roles.filter((r) => r !== role) : [...target.roles, role];
    // Un admin no puede quitarse su propio rol admin (el backend también lo valida).
    if (target.sub === currentUser?.sub && has && role === 'admin') return;
    updateRolesMutation.mutate({ sub: target.sub, data: { roles: next } });
  };

  const submitEdit = () => {
    if (!editing) return;
    updateUserMutation.mutate({ sub: editing.sub, data: { email: editing.email, name: editing.name || null } });
  };

  const users = usersQuery.data ?? [];
  const adminCount = users.filter((u) => u.roles.includes('admin')).length;

  return (
    <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
      <PageHeading
        eyebrow="Administración"
        title="Usuarios"
        description="Gestión de identidades locales, roles y acceso al sistema."
        action={<div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-xs font-bold text-muted-foreground"><span className="h-2 w-2 rounded-full bg-primary" /> {users.length} usuarios · {adminCount} admin</div>}
      />

      {error && <div className="mb-4 rounded-xl border border-[#e5c2bb] bg-[#fdf0ee] px-4 py-3 text-xs font-semibold text-[#a3453a]" data-testid="text-users-error">{error}</div>}

      <div className="rounded-2xl border border-card-border bg-card shadow-[var(--shadow-card)]">
        {usersQuery.isLoading ? (
          <div className="space-y-4 p-5">{[1, 2, 3].map((row) => <div className="flex gap-4 border-b border-border pb-4" key={row}><div className="skeleton h-9 w-9 rounded-xl" /><div className="flex-1"><div className="skeleton h-4 w-1/2 rounded" /><div className="mt-2 skeleton h-3 w-1/3 rounded" /></div></div>)}</div>
        ) : usersQuery.isError ? (
          <div className="p-12 text-center"><CircleHelp className="mx-auto mb-3 text-[#bf5a4e]" /><p className="font-display font-bold">No pudimos cargar los usuarios.</p><button onClick={() => usersQuery.refetch()} className="mt-4 text-xs font-bold text-primary underline" data-testid="button-retry-users">Reintentar</button></div>
        ) : (
          <div>
            {users.map((u) => <UserRow key={u.sub} u={u} currentUserSub={currentUser?.sub} toggleRole={toggleRole} onEdit={() => setEditing({ sub: u.sub, email: u.email, name: u.name ?? '' })} rolesPending={updateRolesMutation.isPending} />)}
          </div>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[#111c2c]/40 px-5" data-testid="dialog-edit-user">
          <div className="w-full max-w-md rounded-2xl border border-card-border bg-card p-6 shadow-[var(--shadow-card)]">
            <p className="label-caps">Editar usuario</p>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-bold">Email</span>
                <input type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-xs outline-none focus:border-primary" data-testid="input-edit-email" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold">Nombre</span>
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-xs outline-none focus:border-primary" data-testid="input-edit-name" />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => { setEditing(null); setError(null); }} className="rounded-lg border border-border px-4 py-2 text-xs font-bold text-muted-foreground hover:text-foreground" data-testid="button-cancel-edit">Cancelar</button>
              <button onClick={submitEdit} disabled={updateUserMutation.isPending} className="rounded-lg bg-foreground px-4 py-2 text-xs font-bold text-background hover:-translate-y-0.5 transition-transform disabled:opacity-50" data-testid="button-save-edit">{updateUserMutation.isPending ? 'Guardando…' : 'Guardar'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground"><ShieldCheck size={13} /> Los roles se validan en el servidor. No es posible retirar el rol admin al último administrador.</div>
    </section>
  );
}

function UserRow({ u, currentUserSub, toggleRole, onEdit, rolesPending }: {
  u: AdminUser;
  currentUserSub?: string;
  toggleRole: (target: AdminUser, role: 'admin' | 'auditor') => void;
  onEdit: () => void;
  rolesPending: boolean;
}) {
  const isSelfAdmin = u.sub === currentUserSub && u.roles.includes('admin');
  return (
    <div className="flex flex-col gap-4 border-b border-border/70 p-5 last:border-0 md:flex-row md:items-center" data-testid={`row-user-${u.email}`}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e4f2ef] text-[#237b6c]"><Users size={18} /></div>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{u.email}{isSelfAdmin && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">tú</span>}</p>
          <p className="truncate text-xs text-muted-foreground">{u.name ?? 'sin nombre'}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-6 md:w-[300px]">
        <div><p className="label-caps">Creado</p><p className="mt-1 text-xs font-medium">{formatDate(u.createdAt)}</p></div>
        <div><p className="label-caps">Último login</p><p className="mt-1 text-xs font-medium">{formatDate(u.lastLoginAt)}</p></div>
      </div>
      <div className="flex items-center gap-2 md:w-[190px]">
        {(['admin', 'auditor'] as const).map((role) => (
          <button
            key={role}
            onClick={() => toggleRole(u, role)}
            disabled={rolesPending || isSelfAdmin}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[11px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${u.roles.includes(role) ? 'border-[#bfe0d6] bg-[#e4f2ef] text-[#1d6a5c]' : 'border-border bg-muted text-muted-foreground hover:border-primary/40'}`}
            data-testid={`button-role-${role}-${u.email}`}
            title={role === 'admin' ? 'Rol de administración total' : 'Rol de auditoría (lectura)'}
          >
            {role === 'admin' && <ShieldCheck size={12} />}
            {role === 'auditor' && <UserCog size={12} />}
            {role}
          </button>
        ))}
      </div>
      <div className="md:w-[80px] md:text-right">
        <button onClick={onEdit} className="text-xs font-bold text-primary underline" data-testid={`button-edit-${u.email}`}>Editar</button>
      </div>
    </div>
  );
}