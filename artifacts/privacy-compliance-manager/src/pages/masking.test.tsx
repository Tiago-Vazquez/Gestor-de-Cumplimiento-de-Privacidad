import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadMaskingJob,
  getListMaskingJobsQueryKey,
  useCreateMaskingJob,
  useGetMaskingJob,
  useListMaskingJobs,
  useListSources,
  usePreviewMasking,
} from '@workspace/api-client-react';
import { useAuth } from '@/auth/auth-context';
import MaskingPage from './masking';

vi.mock('@workspace/api-client-react', async () => {
  const actual = await vi.importActual<typeof import('@workspace/api-client-react')>(
    '@workspace/api-client-react',
  );
  return {
    ...actual,
    downloadMaskingJob: vi.fn(),
    useCreateMaskingJob: vi.fn(),
    useGetMaskingJob: vi.fn(),
    useListMaskingJobs: vi.fn(),
    useListSources: vi.fn(),
    usePreviewMasking: vi.fn(),
  };
});

vi.mock('@/auth/auth-context', () => ({ useAuth: vi.fn() }));

const mockDownloadMaskingJob = vi.mocked(downloadMaskingJob);
const mockUseCreateMaskingJob = vi.mocked(useCreateMaskingJob);
const mockUseGetMaskingJob = vi.mocked(useGetMaskingJob);
const mockUseListMaskingJobs = vi.mocked(useListMaskingJobs);
const mockUseListSources = vi.mocked(useListSources);
const mockUsePreviewMasking = vi.mocked(usePreviewMasking);
const mockUseAuth = vi.mocked(useAuth);

const mockSources = [{ id: 'src-001', name: 'Customer PostgreSQL' }];

const mockJobs = [
  {
    id: 'mj-001',
    sourceId: 'src-001',
    fields: ['email', 'phone'],
    status: 'ready',
    createdAt: '2026-10-01T10:00:00.000Z',
    completedAt: '2026-10-01T10:00:03.000Z',
    records: 120,
    error: null,
  },
  {
    id: 'mj-002',
    sourceId: 'src-001',
    fields: ['national_id'],
    status: 'failed',
    createdAt: '2026-10-01T09:00:00.000Z',
    completedAt: '2026-10-01T09:00:01.000Z',
    records: 0,
    error: 'source_unreachable',
  },
];

const manyJobs = Array.from({ length: 12 }, (_, index) => ({
  id: `mj-${String(index + 1).padStart(3, '0')}`,
  sourceId: 'src-001',
  fields: ['email'],
  status: 'ready' as const,
  createdAt: `2026-10-0${(index % 9) + 1}T10:00:00.000Z`,
  completedAt: `2026-10-0${(index % 9) + 1}T10:00:01.000Z`,
  records: 10,
  error: null,
}));

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderMasking(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Router>
        <MaskingPage />
      </Router>
    </QueryClientProvider>,
  );
}

function defaultQuery(value: unknown) {
  return value as never;
}

describe('MaskingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({ isAdmin: true, logout: vi.fn() } as never);
    mockUseListSources.mockReturnValue(
      defaultQuery({ isLoading: false, isError: false, data: mockSources, refetch: vi.fn() }),
    );
    mockUseListMaskingJobs.mockReturnValue(
      defaultQuery({ isLoading: false, isError: false, data: [], refetch: vi.fn() }),
    );
    mockUsePreviewMasking.mockReturnValue(
      defaultQuery({ mutate: vi.fn(), isPending: false, isError: false }),
    );
    mockUseCreateMaskingJob.mockReturnValue(
      defaultQuery({ mutate: vi.fn(), isPending: false, isError: false }),
    );
    mockUseGetMaskingJob.mockReturnValue(
      defaultQuery({ isLoading: false, isError: false, data: undefined, refetch: vi.fn() }),
    );
  });

  it('renders the loading state while the history is loading', () => {
    mockUseListMaskingJobs.mockReturnValue(
      defaultQuery({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() }),
    );
    const queryClient = createQueryClient();
    renderMasking(queryClient);
    expect(document.querySelector('.skeleton')).not.toBeNull();
  });

  it('renders the error state with a retry button when the history fails', async () => {
    const refetch = vi.fn();
    mockUseListMaskingJobs.mockReturnValue(
      defaultQuery({ isLoading: false, isError: true, data: undefined, refetch }),
    );
    const user = userEvent.setup();
    const queryClient = createQueryClient();
    renderMasking(queryClient);
    expect(screen.getByText(/No pudimos cargar el historial de jobs/i)).toBeInTheDocument();
    await user.click(screen.getByTestId('button-retry-masking-jobs'));
    expect(refetch).toHaveBeenCalled();
  });

  it('renders the job history with badges when data arrives', () => {
    mockUseListMaskingJobs.mockReturnValue(
      defaultQuery({ isLoading: false, isError: false, data: mockJobs, refetch: vi.fn() }),
    );
    const queryClient = createQueryClient();
    renderMasking(queryClient);
    expect(screen.getByTestId('row-masking-job-mj-001')).toBeInTheDocument();
    expect(screen.getByTestId('row-masking-job-mj-002')).toBeInTheDocument();
    expect(screen.getByText('Listo')).toBeInTheDocument();
    expect(screen.getByText('Fallido')).toBeInTheDocument();
    expect(screen.getByText('email, phone')).toBeInTheDocument();
  });

  it('paginates the history client-side (10 por página)', async () => {
    mockUseListMaskingJobs.mockReturnValue(
      defaultQuery({ isLoading: false, isError: false, data: manyJobs, refetch: vi.fn() }),
    );
    const user = userEvent.setup();
    const queryClient = createQueryClient();
    renderMasking(queryClient);

    const rowCount = () => document.querySelectorAll('[data-testid^="row-masking-job-"]').length;
    expect(rowCount()).toBe(10);
    expect(screen.getByText(/Página 1 de 2/)).toBeInTheDocument();
    expect(screen.getByTestId('button-prev-page')).toBeDisabled();

    await user.click(screen.getByTestId('button-next-page'));
    expect(rowCount()).toBe(2);
    expect(screen.getByText(/Página 2 de 2/)).toBeInTheDocument();
    expect(screen.getByTestId('button-next-page')).toBeDisabled();
  });

  it('creates a job (admin) and invalidates the history query', async () => {
    mockUseListMaskingJobs.mockReturnValue(
      defaultQuery({ isLoading: false, isError: false, data: [], refetch: vi.fn() }),
    );
    const queryClient = createQueryClient();
    const invalidateSpy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue(undefined);
    const mutate = vi.fn((_input: unknown, callbacks: { onSuccess?: () => void }) => {
      callbacks.onSuccess?.();
    });
    mockUseCreateMaskingJob.mockReturnValue(defaultQuery({ mutate, isPending: false }));

    const user = userEvent.setup();
    renderMasking(queryClient);

    await waitFor(() => {
      expect(screen.getByTestId('button-submit-masking-job')).toBeEnabled();
    });
    await user.click(screen.getByTestId('button-submit-masking-job'));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { sourceId: 'src-001', fields: ['email', 'phone', 'national_id'] },
        }),
        expect.anything(),
      );
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: getListMaskingJobsQueryKey(),
      });
    });
  });

  it('shows an inline error when the creation fails', async () => {
    const mutate = vi.fn((_input: unknown, callbacks: { onError?: () => void }) => {
      callbacks.onError?.();
    });
    mockUseCreateMaskingJob.mockReturnValue(defaultQuery({ mutate, isPending: false }));

    const user = userEvent.setup();
    const queryClient = createQueryClient();
    renderMasking(queryClient);

    await waitFor(() => {
      expect(screen.getByTestId('button-submit-masking-job')).toBeEnabled();
    });
    await user.click(screen.getByTestId('button-submit-masking-job'));

    await waitFor(() => {
      expect(screen.getByTestId('error-masking-job')).toHaveTextContent(
        /No se pudo generar el dataset/i,
      );
    });
    expect(mutate).toHaveBeenCalled();
  });

  it('hides the create button for non-admin users', () => {
    mockUseAuth.mockReturnValue({ isAdmin: false, logout: vi.fn() } as never);
    const queryClient = createQueryClient();
    renderMasking(queryClient);
    expect(screen.queryByTestId('button-submit-masking-job')).not.toBeInTheDocument();
  });

  it('downloads the persisted dataset only for ready jobs', async () => {
    mockUseListMaskingJobs.mockReturnValue(
      defaultQuery({ isLoading: false, isError: false, data: mockJobs, refetch: vi.fn() }),
    );
    mockDownloadMaskingJob.mockResolvedValue({
      jobId: 'mj-001',
      records: 120,
      fields: ['email', 'phone'],
      rows: [{ email: 'ab12@demo.com', phone: '5491155554821' }],
    } as never);

    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    try {
      const user = userEvent.setup();
      const queryClient = createQueryClient();
      renderMasking(queryClient);

      await user.click(screen.getByTestId('button-view-masking-job-mj-001'));
      await waitFor(() => {
        expect(screen.getByTestId('button-download-masking-job-mj-001')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('button-download-masking-job-mj-001'));

      await waitFor(() => {
        expect(mockDownloadMaskingJob).toHaveBeenCalledWith('mj-001');
      });
      await waitFor(() => {
        expect(createObjectURL).toHaveBeenCalled();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows the failed detail with error and without download for failed jobs', async () => {
    mockUseListMaskingJobs.mockReturnValue(
      defaultQuery({ isLoading: false, isError: false, data: mockJobs, refetch: vi.fn() }),
    );
    const user = userEvent.setup();
    const queryClient = createQueryClient();
    renderMasking(queryClient);

    await user.click(screen.getByTestId('button-view-masking-job-mj-002'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-masking-job-id')).toHaveTextContent('mj-002');
    });
    expect(screen.getByTestId('detail-masking-error')).toHaveTextContent('source_unreachable');
    expect(
      screen.queryByTestId('button-download-masking-job-mj-002'),
    ).not.toBeInTheDocument();
  });

  it('shows the ready job detail with fields and records', async () => {
    mockUseListMaskingJobs.mockReturnValue(
      defaultQuery({ isLoading: false, isError: false, data: mockJobs, refetch: vi.fn() }),
    );
    const user = userEvent.setup();
    const queryClient = createQueryClient();
    renderMasking(queryClient);

    await user.click(screen.getByTestId('button-view-masking-job-mj-001'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-masking-job-id')).toHaveTextContent('mj-001');
    });
    expect(screen.getAllByText('email, phone').length).toBeGreaterThan(0);
    expect(screen.getAllByText('120').length).toBeGreaterThan(0);
  });

  it('exposes only the supported field catalog (no address)', () => {
    const queryClient = createQueryClient();
    renderMasking(queryClient);
    expect(screen.queryByTestId('button-toggle-field-address')).not.toBeInTheDocument();
    for (const field of ['email', 'phone', 'national_id', 'credit_card']) {
      expect(screen.getByTestId(`button-toggle-field-${field}`)).toBeInTheDocument();
    }
  });
});