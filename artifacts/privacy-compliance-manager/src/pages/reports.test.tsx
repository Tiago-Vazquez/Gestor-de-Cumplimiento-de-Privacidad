import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadReport,
  getListReportsQueryKey,
  useCreateReport,
  useListReports,
} from '@workspace/api-client-react';
import ReportsPage from './reports';

vi.mock('@workspace/api-client-react', async () => {
  const actual = await vi.importActual<typeof import('@workspace/api-client-react')>(
    '@workspace/api-client-react',
  );
  return {
    ...actual,
    downloadReport: vi.fn(),
    useCreateReport: vi.fn(),
    useListReports: vi.fn(),
  };
});

vi.mock('@/auth/auth-context', () => ({
  useAuth: () => ({ isAdmin: true, user: { roles: ['admin'] }, logout: vi.fn() }),
}));

const mockDownloadReport = vi.mocked(downloadReport);
const mockUseCreateReport = vi.mocked(useCreateReport);
const mockUseListReports = vi.mocked(useListReports);

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderReports(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Router>
        <ReportsPage />
      </Router>
    </QueryClientProvider>,
  );
}

const mockReports = [
  {
    id: 'r-001',
    name: 'Auditoría Q2',
    period: 'last_30d',
    status: 'ready',
    createdAt: '2026-09-01T10:00:00.000Z',
    findings: 42,
    complianceScore: 87.5,
    format: 'pdf',
  },
  {
    id: 'r-002',
    name: 'Auditoría Q1',
    period: 'last_7d',
    status: 'ready',
    createdAt: '2026-06-01T10:00:00.000Z',
    findings: 10,
    complianceScore: 92.1,
    format: 'pdf',
  },
];

describe('ReportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownloadReport.mockResolvedValue(mockReports[0] as never);
    mockUseCreateReport.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as never);
  });

  it('renders loading state while reports are loading', () => {
    mockUseListReports.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
      refetch: vi.fn(),
    } as never);

    const queryClient = createQueryClient();
    renderReports(queryClient);
    expect(document.querySelector('.skeleton')).not.toBeNull();
  });

  it('renders error state and retry button when the request fails', async () => {
    mockUseListReports.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      refetch: vi.fn(),
    } as never);

    const queryClient = createQueryClient();
    renderReports(queryClient);
    expect(screen.getByText(/No pudimos cargar los informes/i)).toBeInTheDocument();
    expect(screen.getByTestId('button-retry-reports')).toBeInTheDocument();
  });

  it('renders the list of reports when data arrives', () => {
    mockUseListReports.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockReports,
      refetch: vi.fn(),
    } as never);

    const queryClient = createQueryClient();
    renderReports(queryClient);
    expect(screen.getByText('Auditoría Q2')).toBeInTheDocument();
    expect(screen.getByText('Auditoría Q1')).toBeInTheDocument();
    expect(screen.getByTestId('row-report-r-001')).toBeInTheDocument();
    expect(screen.getByText('87.5%')).toBeInTheDocument();
  });

  it('calls downloadReport(id) with the report id when the download button is clicked', async () => {
    mockUseListReports.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockReports,
      refetch: vi.fn(),
    } as never);

    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    try {
      const user = userEvent.setup();
      const queryClient = createQueryClient();
      renderReports(queryClient);

      const button = screen.getByTestId('button-download-report-r-001');
      await user.click(button);

      await waitFor(() => {
        expect(mockDownloadReport).toHaveBeenCalledWith('r-001');
      });
      await waitFor(() => {
        expect(createObjectURL).toHaveBeenCalled();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('invalidates the reports list after a successful creation', async () => {
    mockUseListReports.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [],
      refetch: vi.fn(),
    } as never);

    const queryClient = createQueryClient();
    const invalidateSpy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue(undefined);
    const mutate = vi.fn((_input: never, callbacks: { onSuccess?: () => void }) => {
      callbacks.onSuccess?.();
    });

    mockUseCreateReport.mockReturnValue({ mutate, isPending: false } as never);

    const user = userEvent.setup();
    renderReports(queryClient);

    await user.click(screen.getByTestId('button-empty-create-report'));
    await user.type(screen.getByTestId('input-report-name'), 'Nuevo informe');
    await user.click(screen.getByTestId('button-submit-report'));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalled();
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: getListReportsQueryKey(),
      });
    });
  });
});