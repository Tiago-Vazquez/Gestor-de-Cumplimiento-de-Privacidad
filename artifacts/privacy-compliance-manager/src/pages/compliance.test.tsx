import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGetComplianceTrendQueryKey,
  useGetCompliance,
  useGetComplianceTrend,
} from '@workspace/api-client-react';
import CompliancePage from './compliance';

vi.mock('@workspace/api-client-react', async () => {
  const actual = await vi.importActual<typeof import('@workspace/api-client-react')>(
    '@workspace/api-client-react',
  );
  return {
    ...actual,
    useGetCompliance: vi.fn(),
    useGetComplianceTrend: vi.fn(),
  };
});

const mockUseGetCompliance = vi.mocked(useGetCompliance);
const mockUseGetComplianceTrend = vi.mocked(useGetComplianceTrend);

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderCompliance(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Router>
        <CompliancePage />
      </Router>
    </QueryClientProvider>,
  );
}

const mockComplianceData = {
  complianceScore: 87.5,
  openFindings: 42,
  findingsBySeverity: { critical: 3, high: 8, medium: 15, low: 16 },
  findingsByDataType: { email: 20, credit_card: 12, phone: 10 },
  findingsBySource: [
    { sourceId: 'src-1', sourceName: 'DB Production', openFindings: 25 },
    { sourceId: 'src-2', sourceName: 'DB Staging', openFindings: 17 },
  ],
};

const mockTrendData = {
  points: [
    { date: '2026-09-01', newFindings: 5, resolvedFindings: 2, completedScans: 1, recordsScanned: 1000 },
    { date: '2026-09-02', newFindings: 3, resolvedFindings: 4, completedScans: 2, recordsScanned: 2000 },
    { date: '2026-09-03', newFindings: 8, resolvedFindings: 1, completedScans: 1, recordsScanned: 1500 },
  ],
};

describe('CompliancePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state when compliance data is loading', () => {
    mockUseGetCompliance.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
      refetch: vi.fn(),
    } as any);

    mockUseGetComplianceTrend.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
    } as any);

    const queryClient = createQueryClient();
    renderCompliance(queryClient);

    expect(screen.getByTestId('loading-cards')).toBeInTheDocument();
  });

  it('renders error state when compliance query fails', async () => {
    const refetch = vi.fn();
    mockUseGetCompliance.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      refetch,
    } as any);

    mockUseGetComplianceTrend.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
    } as any);

    const queryClient = createQueryClient();
    renderCompliance(queryClient);

    expect(screen.getByTestId('compliance-error')).toBeInTheDocument();
    expect(screen.getByText('No pudimos cargar el cumplimiento')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('button-retry-compliance'));
    expect(refetch).toHaveBeenCalled();
  });

  it('renders compliance data correctly', () => {
    mockUseGetCompliance.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockComplianceData,
      refetch: vi.fn(),
    } as any);

    mockUseGetComplianceTrend.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockTrendData,
    } as any);

    const queryClient = createQueryClient();
    renderCompliance(queryClient);

    expect(screen.getByText('87.5%')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('renders findings by source', () => {
    mockUseGetCompliance.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockComplianceData,
      refetch: vi.fn(),
    } as any);

    mockUseGetComplianceTrend.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockTrendData,
    } as any);

    const queryClient = createQueryClient();
    renderCompliance(queryClient);

    expect(screen.getByTestId('row-source-src-1')).toBeInTheDocument();
    expect(screen.getByText('DB Production')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
  });

  it('renders trend chart with correct data points', () => {
    mockUseGetCompliance.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockComplianceData,
      refetch: vi.fn(),
    } as any);

    mockUseGetComplianceTrend.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockTrendData,
    } as any);

    const queryClient = createQueryClient();
    renderCompliance(queryClient);

    expect(screen.getByTestId('chart-trend')).toBeInTheDocument();
  });

  it('changes trend window when selector is clicked', async () => {
    mockUseGetCompliance.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockComplianceData,
      refetch: vi.fn(),
    } as any);

    mockUseGetComplianceTrend.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockTrendData,
    } as any);

    const queryClient = createQueryClient();
    renderCompliance(queryClient);

    const button7 = screen.getByTestId('button-window-7');
    await userEvent.click(button7);

    await waitFor(() => {
      expect(mockUseGetComplianceTrend).toHaveBeenCalledWith(
        { days: 7 },
        expect.objectContaining({
          query: expect.objectContaining({
            queryKey: getGetComplianceTrendQueryKey({ days: 7 }),
          }),
        }),
      );
    });
  });

  it('renders all window selector buttons', () => {
    mockUseGetCompliance.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockComplianceData,
      refetch: vi.fn(),
    } as any);

    mockUseGetComplianceTrend.mockReturnValue({
      isLoading: false,
      isError: false,
      data: mockTrendData,
    } as any);

    const queryClient = createQueryClient();
    renderCompliance(queryClient);

    expect(screen.getByTestId('button-window-7')).toBeInTheDocument();
    expect(screen.getByTestId('button-window-14')).toBeInTheDocument();
    expect(screen.getByTestId('button-window-30')).toBeInTheDocument();
    expect(screen.getByTestId('button-window-90')).toBeInTheDocument();
  });
});
