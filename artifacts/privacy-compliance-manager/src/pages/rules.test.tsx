import { render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ApiError, getListRulesQueryKey, useListRules, useUpdateRule } from '@workspace/api-client-react';
import type { Rule, RuleInput } from '@workspace/api-client-react';
import { Toaster } from '@/components/ui/toaster';
import { useAuth } from '@/auth/auth-context';
import RulesPage from './rules';

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useListRules: vi.fn(),
    useUpdateRule: vi.fn(),
  };
});

vi.mock('@/auth/auth-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/auth-context')>();
  return { ...actual, useAuth: vi.fn(() => authMockValue) };
});

const mockedUseListRules = vi.mocked(useListRules);
const mockedUseUpdateRule = vi.mocked(useUpdateRule);

let authMockValue: { isAdmin: boolean };

const buildMutation = <TVariables, TResult>(options: {
  mutate: (variables: TVariables, callbacks?: { onSuccess: (data: TResult) => void; onError: (error: unknown) => void }) => void;
  isPending?: boolean;
}) =>
  ({
    isPending: options.isPending ?? false,
    isError: false,
    isSuccess: false,
    error: null,
    mutate: options.mutate,
  }) as never;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** Construye un ApiError igual al que produce customFetch ante un fallo del servidor. */
const serverError = (status: number, statusText: string, message: string, method: string) =>
  new ApiError(new Response(null, { status, statusText }), { message }, { method, url: '/api/rules' });

const buildRulesFixture = (): Rule[] => [
  { id: 'rule-1', name: 'Detección de correos', category: 'PII', regulation: 'GDPR', enabled: true, detections: 1284, lastTriggered: '2026-11-09T09:30:00.000Z' },
  { id: 'rule-2', name: 'Tarjetas de crédito', category: 'Financiero', regulation: 'PCI DSS', enabled: false, detections: 0, lastTriggered: '2026-10-02T14:00:00.000Z' },
];

let rulesFixtureState: Rule[];

const pageUi = () => (
  <QueryClientProvider client={queryClient}>
    <RulesPage />
    <Toaster />
  </QueryClientProvider>
);

/** Configura los mocks de queries/mutaciones y renderiza la página con el Toaster. */
function arrange({ isAdmin = true, rules, listState = 'success' }: { isAdmin?: boolean; rules?: Rule[]; listState?: 'loading' | 'error' | 'success' } = {}): { rerender: RenderResult['rerender']; refetch: Mock } {
  authMockValue = { isAdmin };
  const data = rules ?? rulesFixtureState;
  const listQuery = listState === 'error'
    ? { isLoading: false, isError: true, error: new Error('boom'), refetch: vi.fn() }
    : listState === 'loading'
      ? { isLoading: true, isError: false, error: null, refetch: vi.fn() }
      : { isLoading: false, isError: false, error: null, refetch: vi.fn() };
  mockedUseListRules.mockReturnValue({ data: listState === 'success' ? data : undefined, ...listQuery } as never);
  mockedUseUpdateRule.mockReturnValue(
    buildMutation<{ id: string; data: RuleInput }, Rule>({
      mutate: (variables, callbacks) => callbacks?.onSuccess({ ...(rulesFixtureState.find((rule) => rule.id === variables.id) as Rule), enabled: variables.data.enabled }),
    }),
  );
  const result = render(pageUi());
  return { rerender: result.rerender, refetch: listQuery.refetch as Mock };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  rulesFixtureState = buildRulesFixture();
  authMockValue = { isAdmin: true };
});

describe('RulesPage � listado (M7.b)', () => {
  it('1. muestra skeletons mientras el listado carga', () => {
    arrange({ listState: 'loading' });
    expect(screen.getByTestId('rules-loading')).toBeInTheDocument();
  });

  it('2. error del listado + retry', async () => {
    const user = userEvent.setup();
    const { refetch } = arrange({ listState: 'error' });
    expect(screen.getByText('No pudimos cargar las reglas.')).toBeInTheDocument();
    await user.click(screen.getByTestId('button-retry-rules'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('3. empty state cuando el catálogo no tiene reglas', () => {
    arrange({ rules: [] });
    expect(screen.getByTestId('rules-empty')).toBeInTheDocument();
    expect(screen.getByText('El catálogo de reglas está vacío')).toBeInTheDocument();
  });

  it('4. listado correcto de reglas', () => {
    arrange();
    expect(screen.getByTestId('row-rule-rule-1')).toHaveTextContent('Detección de correos');
    expect(screen.getByTestId('row-rule-rule-1')).toHaveTextContent('GDPR');
    expect(screen.getByTestId('row-rule-rule-1')).toHaveTextContent(/1[.,]?284/);
    expect(screen.getByTestId('row-rule-rule-2')).toHaveTextContent('Tarjetas de crédito');
    expect(screen.getByTestId('row-rule-rule-2')).toHaveTextContent('PCI DSS');
    expect(screen.getByText(/1 activas/)).toBeInTheDocument();
    expect(screen.getByTestId('rules-footer')).toBeInTheDocument();
  });
});

describe('RulesPage � gating admin (M7.a)', () => {
  it('5. admin ve y puede operar el toggle de cada regla', () => {
    arrange();
    const toggle1 = screen.getByRole('switch', { name: /Detección de correos/ });
    const toggle2 = screen.getByRole('switch', { name: /Tarjetas de crédito/ });
    expect(toggle1).toBeInTheDocument();
    expect(toggle2).toBeInTheDocument();
    expect(screen.queryByTestId('rule-readonly-rule-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('rules-footer')).toHaveTextContent('Habilitá o deshabilitá reglas desde esta pantalla');
  });

  it('6. no-admin ve el estado en solo lectura y no puede operarlo', () => {
    arrange({ isAdmin: false });
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByTestId('rule-readonly-rule-1')).toHaveTextContent('activa');
    expect(screen.getByTestId('rule-readonly-rule-2')).toHaveTextContent('inactiva');
    expect(screen.getByTestId('rules-footer')).toHaveTextContent('su habilitación está reservada a los administradores');
  });
});

describe('RulesPage � toggle enable/disable (M7.a)', () => {
  it('7. toggle exitoso envía RuleInput con el valor opuesto vía useUpdateRule y notifica', async () => {
    const user = userEvent.setup();
    const { rerender } = arrange();
    const mutateSpy = vi.fn((_variables: { id: string; data: RuleInput }, callbacks?: { onSuccess: (data: Rule) => void }) =>
      callbacks?.onSuccess({ ...rulesFixtureState[0], enabled: false }));
    mockedUseUpdateRule.mockReturnValue(buildMutation<{ id: string; data: RuleInput }, Rule>({ mutate: mutateSpy }));
    rerender(pageUi());
    await user.click(screen.getByTestId('button-toggle-rule-rule-1'));
    expect(mutateSpy).toHaveBeenCalledWith({ id: 'rule-1', data: { enabled: false } }, expect.anything());
    expect(await screen.findByText('Regla actualizada')).toBeInTheDocument();
    // El toast renderiza la descripción dos veces (visible + región aria-live).
    expect(screen.getAllByText(/deshabilitada/).length).toBeGreaterThan(0);
  });

  it('8. toggle fallido muestra el error del servidor y conserva el estado', async () => {
    const user = userEvent.setup();
    const { rerender } = arrange();
    mockedUseUpdateRule.mockReturnValue(
      buildMutation<{ id: string; data: RuleInput }, Rule>({
        mutate: (_variables, callbacks) => callbacks?.onError(serverError(403, 'Forbidden', 'Sólo un admin puede modificar reglas', 'PATCH')),
      }),
    );
    rerender(pageUi());
    await user.click(screen.getByTestId('button-toggle-rule-rule-1'));
    expect(await screen.findByTestId('rule-error-rule-1')).toHaveTextContent('Sólo un admin puede modificar reglas');
    expect(screen.getByText('No se pudo actualizar la regla')).toBeInTheDocument();
    expect(screen.getByTestId('button-toggle-rule-rule-1')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('RulesPage � estados y persistencia (M7.c)', () => {
  it('9. invalida únicamente el listado de reglas después del toggle', async () => {
    const user = userEvent.setup();
    arrange();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(screen.getByTestId('button-toggle-rule-rule-1'));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getListRulesQueryKey() }));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('10. el estado mostrado proviene del backend tras el refetch, no de estado local', async () => {
    const user = userEvent.setup();
    const { rerender } = arrange();
    await user.click(screen.getByTestId('button-toggle-rule-rule-1'));
    // El backend persistió el cambio: el refetch devuelve el nuevo estado.
    rulesFixtureState = rulesFixtureState.map((rule) => (rule.id === 'rule-1' ? { ...rule, enabled: false } : rule));
    mockedUseListRules.mockReturnValue({ data: rulesFixtureState, isLoading: false, isError: false, error: null, refetch: vi.fn() } as never);
    rerender(pageUi());
    const toggle = screen.getByTestId('button-toggle-rule-rule-1');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveTextContent('Deshabilitada');
    expect(screen.getByRole('switch', { name: 'Habilitar la regla Detección de correos' })).toBeInTheDocument();
  });

  it('11. la mutación muestra loading y se recupera al terminar', async () => {
    const user = userEvent.setup();
    const { rerender } = arrange();
    let pending = false;
    let captured: { onSuccess: (data: Rule) => void; onError: (error: unknown) => void } | undefined;
    mockedUseUpdateRule.mockImplementation(
      () =>
        ({
          isPending: pending,
          isError: false,
          isSuccess: false,
          error: null,
          mutate: (_variables: { id: string; data: RuleInput }, callbacks?: { onSuccess: (data: Rule) => void; onError: (error: unknown) => void }) => {
            captured = callbacks;
          },
        }) as never,
    );
    rerender(pageUi());
    await user.click(screen.getByTestId('button-toggle-rule-rule-1'));
    pending = true;
    rerender(pageUi());
    expect(screen.getByTestId('button-toggle-rule-rule-1')).toBeDisabled();
    expect(screen.getByTestId('button-toggle-rule-rule-1')).toHaveAttribute('aria-busy', 'true');
    pending = false;
    captured?.onSuccess({ ...rulesFixtureState[0], enabled: false });
    rerender(pageUi());
    expect(screen.getByTestId('button-toggle-rule-rule-1')).toBeEnabled();
    expect(await screen.findByText('Regla actualizada')).toBeInTheDocument();
  });

  it('12. el control es accesible: role switch, aria-checked y aria-label por regla', () => {
    arrange();
    const toggle1 = screen.getByRole('switch', { name: 'Deshabilitar la regla Detección de correos' });
    expect(toggle1).toHaveAttribute('aria-checked', 'true');
    expect(toggle1).toHaveAttribute('aria-busy', 'false');
    expect(toggle1).toBeEnabled();
    const toggle2 = screen.getByRole('switch', { name: 'Habilitar la regla Tarjetas de crédito' });
    expect(toggle2).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('rule-error-rule-1')).not.toBeInTheDocument();
  });
});


