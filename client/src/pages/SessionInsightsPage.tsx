import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, apiClient, apiRequestBlob, getAccessToken } from '../api';
import { AppLayout } from '../ui/AppLayout';
import { SessionExpiryExtendDialogManager } from '../ui/SessionExpiryExtendDialogManager';
import { useToast } from '../ui/toast-provider';

type AccountType = 'credit' | 'checking' | 'savings';
const MONTHLY_EXPENSE_WINDOW = 3;

interface SessionFileItem {
  id: string;
  originalName: string;
  displayName?: string;
  accountType?: AccountType;
  status?: string;
}

interface GroupedSessionFilesResponse {
  credit?: SessionFileItem[];
  checking?: SessionFileItem[];
  savings?: SessionFileItem[];
  root?: SessionFileItem[];
}

interface SessionDetailsResponse {
  sessionId: string;
  expiresAt?: string;
}

interface ParsedStatementItem {
  id?: string;
  fileId: string;
  status: 'pending' | 'processing' | 'parsed' | 'failed' | 'needs_review' | string;
  parserVersion?: string;
  updatedAt?: string;
  statementMeta?: {
    closingBalance?: number;
    openingBalance?: number;
    minPayment?: number;
    interestCharged?: number;
    interestCollected?: number;
    feesCharged?: number;
    apr?: number;
  };
  totals?: {
    totalDebits?: number;
    totalCredits?: number;
  };
  confidence?: {
    overall?: number;
    notes?: string[];
  };
}

interface QueueParseResponse {
  queued: Array<{ fileId: string; status: string }>;
  skipped: string[];
  deferred?: Array<{ fileId: string; reason: string }>;
}

interface TransactionItem {
  id: string;
  txnDate?: string;
  descriptionRaw?: string;
  descriptionNormalized?: string;
  amount?: number;
}

const TERMINAL_PARSE_STATUSES = new Set(['parsed', 'failed', 'needs_review']);
const PARSE_STATUS_PROGRESS_WEIGHT: Record<string, number> = {
  pending: 0.2,
  processing: 0.65,
  parsed: 1,
  failed: 1,
  needs_review: 1,
};
const PARSE_STATUS_FILTER_ORDER = ['not_queued', 'pending', 'processing', 'parsed', 'needs_review', 'failed'];

interface ParseTrackingSnapshot {
  fileIds: string[];
  startedAt: number;
}

const ACCOUNT_TYPE_COPY: Record<AccountType, {
  title: string;
  emptyTitle: string;
  emptyDescription: string;
  ctaLabel: string;
}> = {
  credit: {
    title: 'Credit files',
    emptyTitle: 'No credit statements uploaded',
    emptyDescription: 'Upload a credit statement to include debt and interest data in evaluation.',
    ctaLabel: 'Upload a credit statement',
  },
  checking: {
    title: 'Checking files',
    emptyTitle: 'No checking statements uploaded',
    emptyDescription: 'Upload a checking statement to estimate monthly expenses.',
    ctaLabel: 'Upload a checking statement',
  },
  savings: {
    title: 'Savings files',
    emptyTitle: 'No savings statements uploaded',
    emptyDescription: 'Upload a savings statement to calculate your emergency fund gap or surplus.',
    ctaLabel: 'Upload a savings statement',
  },
};

function resolveDisplayName(file: Pick<SessionFileItem, 'displayName' | 'originalName'>): string {
  const candidate = file.displayName?.trim();
  return candidate && candidate.length > 0 ? candidate : file.originalName;
}

function formatDate(value?: string): string {
  if (!value) {
    return '-';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeGroupedFiles(response: GroupedSessionFilesResponse): Required<GroupedSessionFilesResponse> {
  return {
    credit: response.credit ?? [],
    checking: response.checking ?? [],
    savings: response.savings ?? [],
    root: response.root ?? [],
  };
}

function getParseProgressWeight(status: string): number {
  return PARSE_STATUS_PROGRESS_WEIGHT[status] ?? 0;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.max(1, Math.round(seconds))}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function formatStatusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function inferCollectedInterestFromTransactions(transactions: TransactionItem[]): number | null {
  let total = 0;
  let matched = false;

  transactions.forEach((txn) => {
    const amount = toFiniteNumber(txn.amount);
    if (amount === null || amount <= 0) {
      return;
    }

    const description = (txn.descriptionNormalized ?? txn.descriptionRaw ?? '').toLowerCase();
    if (!description) {
      return;
    }

    if (description.includes('interest') || description.includes('int paid')) {
      total += amount;
      matched = true;
    }
  });

  return matched ? total : null;
}

function getParseTrackingStorageKey(sessionId: string): string {
  return `balance.parseTracking.${sessionId}`;
}

function parseTrackingSnapshotFromStorage(rawValue: string | null): ParseTrackingSnapshot | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as ParseTrackingSnapshot;
    if (!Array.isArray(parsed.fileIds) || typeof parsed.startedAt !== 'number') {
      return null;
    }

    const fileIds = [...new Set(parsed.fileIds.filter((fileId) => typeof fileId === 'string' && fileId.length > 0))];
    if (fileIds.length === 0 || !Number.isFinite(parsed.startedAt)) {
      return null;
    }

    return { fileIds, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

export function SessionInsightsPage() {
  const { sessionId } = useParams();
  const { showToast } = useToast();
  const hasAccessToken = Boolean(getAccessToken());

  const [filesByAccount, setFilesByAccount] = useState<Required<GroupedSessionFilesResponse>>({
    credit: [],
    checking: [],
    savings: [],
    root: [],
  });
  const [parsedStatements, setParsedStatements] = useState<ParsedStatementItem[]>([]);
  const [transactionsByFileId, setTransactionsByFileId] = useState<Record<string, TransactionItem[]>>({});
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [hasInitializedSelection, setHasInitializedSelection] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isQueueingParse, setIsQueueingParse] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [lastRecalculatedAt, setLastRecalculatedAt] = useState<string | null>(null);
  const [viewingFileId, setViewingFileId] = useState<string | null>(null);
  const [parseTrackingFileIds, setParseTrackingFileIds] = useState<string[]>([]);
  const [parseMonitorStartedAt, setParseMonitorStartedAt] = useState<number | null>(null);
  const [parseMonitorNow, setParseMonitorNow] = useState<number>(() => Date.now());
  const [restoredParseTrackingSessionId, setRestoredParseTrackingSessionId] = useState<string | null>(null);
  const [selectedParseStatusFilters, setSelectedParseStatusFilters] = useState<string[]>([]);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);

  const selectableFiles = useMemo(
    () => [...filesByAccount.credit, ...filesByAccount.checking, ...filesByAccount.savings],
    [filesByAccount],
  );

  const selectableFileIds = useMemo(
    () => selectableFiles.map((file) => file.id),
    [selectableFiles],
  );

  const selectableFileIdSet = useMemo(
    () => new Set(selectableFileIds),
    [selectableFileIds],
  );

  const parsedByFileId = useMemo(() => {
    const map = new Map<string, ParsedStatementItem>();
    parsedStatements.forEach((entry) => map.set(entry.fileId, entry));
    return map;
  }, [parsedStatements]);

  const fileById = useMemo(() => {
    const map = new Map<string, SessionFileItem>();
    selectableFiles.forEach((file) => map.set(file.id, file));
    return map;
  }, [selectableFiles]);

  const parsedSelectedFiles = useMemo(
    () =>
      selectedFileIds
        .filter((fileId) => selectableFileIdSet.has(fileId))
        .map((fileId) => fileById.get(fileId))
        .filter((file): file is SessionFileItem => Boolean(file))
        .filter((file) => parsedByFileId.get(file.id)?.status === 'parsed'),
    [fileById, parsedByFileId, selectableFileIdSet, selectedFileIds],
  );

  const parseableFileIds = useMemo(
    () => selectableFiles.map((file) => file.id),
    [selectableFiles],
  );

  const neededTransactionFileIds = useMemo(() => {
    const ids = new Set<string>();
    parsedSelectedFiles.forEach((file) => {
      if (file.accountType === 'checking') {
        ids.add(file.id);
        return;
      }

      if (file.accountType === 'savings') {
        ids.add(file.id);
        return;
      }

      if (file.accountType === 'credit') {
        const parsed = parsedByFileId.get(file.id);
        const closingBalance = toFiniteNumber(parsed?.statementMeta?.closingBalance);
        if (closingBalance === null) {
          ids.add(file.id);
        }
      }
    });
    return [...ids];
  }, [parsedByFileId, parsedSelectedFiles]);

  const pendingTransactionFileIds = useMemo(
    () => neededTransactionFileIds.filter((fileId) => !transactionsByFileId[fileId]),
    [neededTransactionFileIds, transactionsByFileId],
  );

  const parseProgress = useMemo(() => {
    if (parseTrackingFileIds.length === 0 || parseMonitorStartedAt === null) {
      return null;
    }

    const total = parseTrackingFileIds.length;
    let weightedComplete = 0;
    let completedCount = 0;
    let processingCount = 0;
    let pendingCount = 0;
    let queuedCount = 0;

    parseTrackingFileIds.forEach((fileId) => {
      const status = parsedByFileId.get(fileId)?.status ?? 'not_queued';
      weightedComplete += getParseProgressWeight(status);
      if (TERMINAL_PARSE_STATUSES.has(status)) {
        completedCount += 1;
        return;
      }
      if (status === 'processing') {
        processingCount += 1;
        return;
      }
      if (status === 'pending') {
        pendingCount += 1;
        return;
      }
      queuedCount += 1;
    });

    const completed = Math.min(total, weightedComplete);
    let percent = Math.round((completed / total) * 100);
    if (completedCount < total) {
      percent = Math.min(percent, 99);
    } else {
      percent = 100;
    }

    const elapsedSeconds = Math.max(1, (parseMonitorNow - parseMonitorStartedAt) / 1000);
    let etaSeconds = 0;
    if (completedCount < total) {
      if (completed > 0.2) {
        const unitsPerSecond = completed / elapsedSeconds;
        etaSeconds = Math.max(1, (total - completed) / Math.max(unitsPerSecond, 0.03));
      } else {
        etaSeconds = processingCount * 12 + pendingCount * 24 + queuedCount * 18;
      }
    }

    return {
      total,
      completedCount,
      processingCount,
      pendingCount,
      queuedCount,
      percent,
      etaLabel: completedCount >= total
        ? 'Parsing complete.'
        : `Estimated time remaining: ${formatDuration(etaSeconds)} (updates as files finish).`,
    };
  }, [parseMonitorNow, parseMonitorStartedAt, parseTrackingFileIds, parsedByFileId]);

  const interestInsights = useMemo(() => {
    const creditFiles = parsedSelectedFiles.filter((file) => file.accountType === 'credit');
    const creditRows = creditFiles.map((file) => {
      const parsed = parsedByFileId.get(file.id);
      const interestCharged = toFiniteNumber(parsed?.statementMeta?.interestCharged);
      const apr = toFiniteNumber(parsed?.statementMeta?.apr);
      const minPayment = toFiniteNumber(parsed?.statementMeta?.minPayment);
      const hasDetectedInterestDetails = (
        interestCharged !== null
        || apr !== null
        || minPayment !== null
      );

      return {
        fileId: file.id,
        displayName: resolveDisplayName(file),
        interestCharged,
        apr,
        minPayment,
        hasDetectedInterestDetails,
      };
    });

    const interestPaidTotal = creditRows.reduce((acc, row) => {
      if (row.interestCharged === null) {
        return acc;
      }
      return acc + row.interestCharged;
    }, 0);

    const depositFiles = parsedSelectedFiles.filter(
      (file) => file.accountType === 'checking' || file.accountType === 'savings',
    );
    const depositRows = depositFiles.map((file) => {
      const parsed = parsedByFileId.get(file.id);
      const explicitInterestCollected = toFiniteNumber(parsed?.statementMeta?.interestCollected);
      const inferredInterestCollected = explicitInterestCollected === null
        ? inferCollectedInterestFromTransactions(transactionsByFileId[file.id] ?? [])
        : null;
      const interestCollected = explicitInterestCollected ?? inferredInterestCollected;
      const sourceLabel = explicitInterestCollected !== null
        ? 'Statement metadata'
        : inferredInterestCollected !== null
          ? 'Transactions'
          : '-';

      return {
        fileId: file.id,
        displayName: resolveDisplayName(file),
        accountType: file.accountType === 'savings' ? 'savings' : 'checking',
        interestCollected,
        sourceLabel,
      };
    });

    const checkingRows = depositRows.filter((row) => row.accountType === 'checking');
    const savingsRows = depositRows.filter((row) => row.accountType === 'savings');

    const interestCollectedTotal = depositRows.reduce((acc, row) => {
      if (row.interestCollected === null) {
        return acc;
      }
      return acc + row.interestCollected;
    }, 0);

    const checkingInterestCollectedTotal = checkingRows.reduce((acc, row) => {
      if (row.interestCollected === null) {
        return acc;
      }
      return acc + row.interestCollected;
    }, 0);

    const savingsInterestCollectedTotal = savingsRows.reduce((acc, row) => {
      if (row.interestCollected === null) {
        return acc;
      }
      return acc + row.interestCollected;
    }, 0);

    return {
      creditRows,
      checkingRows,
      savingsRows,
      interestPaidTotal,
      interestCollectedTotal,
      fileCount: creditFiles.length,
      depositFileCount: depositFiles.length,
      checkingFileCount: checkingRows.length,
      savingsFileCount: savingsRows.length,
      checkingInterestCollectedTotal,
      savingsInterestCollectedTotal,
      missingDetailsCount: creditRows.filter((row) => !row.hasDetectedInterestDetails).length,
      missingCollectedCount: depositRows.filter((row) => row.interestCollected === null).length,
      missingCheckingCollectedCount: checkingRows.filter((row) => row.interestCollected === null).length,
      missingSavingsCollectedCount: savingsRows.filter((row) => row.interestCollected === null).length,
    };
  }, [parsedByFileId, parsedSelectedFiles, transactionsByFileId]);

  const calculationSummary = useMemo(() => {
    const selectedEligibleCount = selectedFileIds.filter((fileId) => selectableFileIdSet.has(fileId)).length;
    const excludedNotParsedCount = Math.max(0, selectedEligibleCount - parsedSelectedFiles.length);
    const monthlyOutflowByMonth = new Map<string, number>();

    let debtTotal = 0;
    let savingsTotal = 0;
    let creditFileCount = 0;
    let savingsFileCount = 0;
    let checkingFileCount = 0;
    let usedCreditFallbackCount = 0;

    parsedSelectedFiles.forEach((file) => {
      const parsed = parsedByFileId.get(file.id);
      if (file.accountType === 'credit') {
        creditFileCount += 1;
        const closingBalance = toFiniteNumber(parsed?.statementMeta?.closingBalance);
        if (closingBalance !== null) {
          debtTotal += closingBalance;
          return;
        }

        const transactions = transactionsByFileId[file.id] ?? [];
        const netFlow = transactions.reduce((acc, txn) => {
          const amount = toFiniteNumber(txn.amount);
          return amount === null ? acc : acc + amount;
        }, 0);
        const inferredDebt = Math.max(0, -netFlow);
        debtTotal += inferredDebt;
        usedCreditFallbackCount += 1;
        return;
      }

      if (file.accountType === 'savings') {
        savingsFileCount += 1;
        const closingBalance = toFiniteNumber(parsed?.statementMeta?.closingBalance);
        if (closingBalance !== null) {
          savingsTotal += closingBalance;
        }
        return;
      }

      if (file.accountType === 'checking') {
        checkingFileCount += 1;
        const transactions = transactionsByFileId[file.id] ?? [];
        transactions.forEach((txn) => {
          const amount = toFiniteNumber(txn.amount);
          if (amount === null || amount >= 0) {
            return;
          }

          const parsedDate = new Date(txn.txnDate ?? '');
          if (Number.isNaN(parsedDate.getTime())) {
            return;
          }

          const monthKey = `${parsedDate.getUTCFullYear()}-${String(parsedDate.getUTCMonth() + 1).padStart(2, '0')}`;
          monthlyOutflowByMonth.set(
            monthKey,
            (monthlyOutflowByMonth.get(monthKey) ?? 0) + Math.abs(amount),
          );
        });
      }
    });

    const monthlyExpenseValues = [...monthlyOutflowByMonth.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .slice(0, MONTHLY_EXPENSE_WINDOW)
      .map(([, value]) => value);

    const expenseMonthly = monthlyExpenseValues.length === 0
      ? 0
      : monthlyExpenseValues.reduce((acc, value) => acc + value, 0) / monthlyExpenseValues.length;

    const target6mo = expenseMonthly * 6;
    const gap = target6mo - savingsTotal;

    return {
      debtTotal,
      savingsTotal,
      expenseMonthly,
      target6mo,
      gap,
      creditFileCount,
      savingsFileCount,
      checkingFileCount,
      usedCreditFallbackCount,
      excludedNotParsedCount,
    };
  }, [
    parsedByFileId,
    parsedSelectedFiles,
    selectedFileIds,
    selectableFileIdSet,
    transactionsByFileId,
  ]);

  const isParseMonitoringActive = parseProgress !== null && parseProgress.completedCount < parseProgress.total;
  const parseStatusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    selectableFiles.forEach((file) => {
      const status = parsedByFileId.get(file.id)?.status ?? 'not_queued';
      counts.set(status, (counts.get(status) ?? 0) + 1);
    });
    return counts;
  }, [parsedByFileId, selectableFiles]);
  const parseStatusFilterOptions = useMemo(() => {
    const ordered = PARSE_STATUS_FILTER_ORDER.filter((status) => parseStatusCounts.has(status));
    const dynamic = [...parseStatusCounts.keys()]
      .filter((status) => !PARSE_STATUS_FILTER_ORDER.includes(status))
      .sort((left, right) => left.localeCompare(right));
    return [...ordered, ...dynamic];
  }, [parseStatusCounts]);
  const filteredParseStatusFiles = useMemo(() => {
    if (selectedParseStatusFilters.length === 0) {
      return selectableFiles;
    }

    const selectedSet = new Set(selectedParseStatusFilters);
    return selectableFiles.filter((file) => {
      const status = parsedByFileId.get(file.id)?.status ?? 'not_queued';
      return selectedSet.has(status);
    });
  }, [parsedByFileId, selectableFiles, selectedParseStatusFilters]);

  useEffect(() => {
    setSelectedFileIds((current) => {
      const filtered = current.filter((fileId) => parsedByFileId.get(fileId)?.status === 'parsed');
      return filtered.length === current.length ? current : filtered;
    });
  }, [parsedByFileId]);

  useEffect(() => {
    setSelectedParseStatusFilters((current) => {
      if (current.length === 0) {
        return current;
      }

      const filtered = current.filter((status) => parseStatusCounts.has(status));
      return filtered.length === current.length ? current : filtered;
    });
  }, [parseStatusCounts]);

  useEffect(() => {
    if (!sessionId) {
      setParseTrackingFileIds([]);
      setParseMonitorStartedAt(null);
      setParseMonitorNow(Date.now());
      setRestoredParseTrackingSessionId(null);
      return;
    }

    const storageKey = getParseTrackingStorageKey(sessionId);
    const snapshot = parseTrackingSnapshotFromStorage(window.sessionStorage.getItem(storageKey));
    setParseTrackingFileIds([]);
    setParseMonitorStartedAt(null);
    if (snapshot) {
      setParseTrackingFileIds(snapshot.fileIds);
      setParseMonitorStartedAt(snapshot.startedAt);
      setParseMonitorNow(Date.now());
    }
    setRestoredParseTrackingSessionId(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || restoredParseTrackingSessionId !== sessionId) {
      return;
    }

    const storageKey = getParseTrackingStorageKey(sessionId);
    if (parseTrackingFileIds.length === 0 || parseMonitorStartedAt === null) {
      window.sessionStorage.removeItem(storageKey);
      return;
    }

    const snapshot: ParseTrackingSnapshot = {
      fileIds: parseTrackingFileIds,
      startedAt: parseMonitorStartedAt,
    };
    window.sessionStorage.setItem(storageKey, JSON.stringify(snapshot));
  }, [parseMonitorStartedAt, parseTrackingFileIds, restoredParseTrackingSessionId, sessionId]);

  useEffect(() => {
    if (!sessionId || !hasAccessToken) {
      return;
    }

    const missingFileIds = neededTransactionFileIds.filter((fileId) => !transactionsByFileId[fileId]);
    if (missingFileIds.length === 0) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function loadMissingTransactions() {
      try {
        const responses = await Promise.all(
          missingFileIds.map((fileId) =>
            apiClient.get<TransactionItem[]>(
              `/sessions/${sessionId}/transactions?fileId=${encodeURIComponent(fileId)}`,
              { signal: controller.signal },
            ).then((rows) => ({ fileId, rows: rows ?? [] })),
          ),
        );

        if (cancelled) {
          return;
        }

        setTransactionsByFileId((current) => {
          const next = { ...current };
          responses.forEach(({ fileId, rows }) => {
            next[fileId] = rows;
          });
          return next;
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        showToast('Unable to load transactions for insights calculations.', 'error');
      }
    }

    void loadMissingTransactions();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hasAccessToken, neededTransactionFileIds, sessionId, showToast, transactionsByFileId]);

  useEffect(() => {
    if (parseTrackingFileIds.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setParseMonitorNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [parseTrackingFileIds.length]);

  useEffect(() => {
    if (!sessionId || !hasAccessToken || parseTrackingFileIds.length === 0) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | undefined;

    async function pollParsedStatuses() {
      try {
        const parsedResponse = await apiClient.get<ParsedStatementItem[]>(`/sessions/${sessionId}/parsed`);
        if (cancelled) {
          return;
        }

        const rows = parsedResponse ?? [];
        setParsedStatements(rows);
        setParseMonitorNow(Date.now());

        const nextByFileId = new Map<string, ParsedStatementItem>();
        rows.forEach((item) => nextByFileId.set(item.fileId, item));

        const allTrackedFilesDone = parseTrackingFileIds.every((fileId) => {
          const status = nextByFileId.get(fileId)?.status ?? '';
          return TERMINAL_PARSE_STATUSES.has(status);
        });

        if (allTrackedFilesDone) {
          setParseTrackingFileIds([]);
          setParseMonitorStartedAt(null);
          setSuccessMessage('Parsing complete for selected files.');
          showToast('Parsing complete for selected files.', 'success');
          return;
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setErrorMessage('To access this page, continue via email link.');
          setParseTrackingFileIds([]);
          setParseMonitorStartedAt(null);
          return;
        }
      }

      if (cancelled) {
        return;
      }

      timeoutId = window.setTimeout(() => {
        void pollParsedStatuses();
      }, 1500);
    }

    void pollParsedStatuses();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [hasAccessToken, parseTrackingFileIds, sessionId, showToast]);

  useEffect(() => {
    if (!sessionId) {
      setErrorMessage('Missing session ID.');
      setIsLoading(false);
      return;
    }

    if (restoredParseTrackingSessionId !== sessionId) {
      return;
    }

    if (!hasAccessToken) {
      setErrorMessage('To access this page, continue via email link.');
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function loadPageData() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const [sessionDetails, groupedFilesResponse, parsedResponse] = await Promise.all([
          apiClient.get<SessionDetailsResponse>(`/sessions/${sessionId}`, {
            signal: controller.signal,
          }),
          apiClient.get<GroupedSessionFilesResponse>(`/sessions/${sessionId}/files?grouped=true`, {
            signal: controller.signal,
          }),
          apiClient.get<ParsedStatementItem[]>(`/sessions/${sessionId}/parsed`, {
            signal: controller.signal,
          }),
        ]);

        if (cancelled) {
          return;
        }

        setSessionExpiresAt(sessionDetails.expiresAt ?? null);
        const normalizedGroupedFiles = normalizeGroupedFiles(groupedFilesResponse);
        setFilesByAccount(normalizedGroupedFiles);
        const normalizedParsedResponse = parsedResponse ?? [];
        setParsedStatements(normalizedParsedResponse);
        setTransactionsByFileId({});

        const nextSelectableIds = [
          ...normalizedGroupedFiles.credit,
          ...normalizedGroupedFiles.checking,
          ...normalizedGroupedFiles.savings,
        ].map((file) => file.id);
        const parsedSelectableIdSet = new Set(
          normalizedParsedResponse
            .filter((entry) => entry.status === 'parsed')
            .map((entry) => entry.fileId),
        );

        setSelectedFileIds((current) => {
          const filteredExisting = current.filter((fileId) => parsedSelectableIdSet.has(fileId));
          if (hasInitializedSelection) {
            return filteredExisting;
          }
          return nextSelectableIds.filter((fileId) => parsedSelectableIdSet.has(fileId));
        });
        if (!hasInitializedSelection) {
          setHasInitializedSelection(true);
        }

        if (restoredParseTrackingSessionId === sessionId) {
          const availableFileIds = new Set(nextSelectableIds);
          const activeParsedFileIds = normalizedParsedResponse
            .filter((entry) => !TERMINAL_PARSE_STATUSES.has(entry.status))
            .map((entry) => entry.fileId)
            .filter((fileId) => availableFileIds.has(fileId));

          setParseTrackingFileIds((current) => {
            const filteredCurrent = current.filter((fileId) => availableFileIds.has(fileId));
            if (filteredCurrent.length > 0) {
              return filteredCurrent;
            }

            if (activeParsedFileIds.length > 0) {
              return [...new Set(activeParsedFileIds)];
            }

            return [];
          });
          setParseMonitorStartedAt((current) => {
            if (current !== null) {
              return current;
            }
            return activeParsedFileIds.length > 0 ? Date.now() : null;
          });
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        if (error instanceof ApiError && error.status === 401) {
          const message = 'To access this page, continue via email link.';
          setErrorMessage(message);
          showToast(message, 'error');
          return;
        }

        const message = 'Unable to load insights data right now.';
        setErrorMessage(message);
        showToast(message, 'error');
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadPageData();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hasAccessToken, hasInitializedSelection, restoredParseTrackingSessionId, sessionId, sessionRefreshKey, showToast]);

  function toggleSelectedFile(fileId: string, checked: boolean) {
    setSelectedFileIds((current) => {
      if (checked) {
        if (current.includes(fileId)) {
          return current;
        }
        return [...current, fileId];
      }

      return current.filter((id) => id !== fileId);
    });
  }

  function toggleParseStatusFilter(status: string) {
    setSelectedParseStatusFilters((current) => {
      if (current.includes(status)) {
        return current.filter((item) => item !== status);
      }
      return [...current, status];
    });
  }

  async function handleViewFile(file: SessionFileItem) {
    if (!file.id) {
      return;
    }

    setViewingFileId(file.id);
    setErrorMessage(null);
    try {
      const blob = await apiRequestBlob(`/files/${file.id}/raw`);
      const objectUrl = URL.createObjectURL(blob);
      const opened = window.open(objectUrl, '_blank', 'noopener,noreferrer');
      if (!opened) {
        URL.revokeObjectURL(objectUrl);
        throw new Error('Popup blocked.');
      }

      window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
      }, 60_000);
    } catch {
      const message = 'Could not open this file.';
      setErrorMessage(message);
      showToast(message, 'error');
    } finally {
      setViewingFileId(null);
    }
  }

  async function handleQueueParse() {
    if (!sessionId) {
      setErrorMessage('Missing session ID.');
      return;
    }

    if (parseableFileIds.length === 0) {
      const message = 'No eligible files found to parse.';
      setSuccessMessage(message);
      return;
    }

    setIsQueueingParse(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const response = await apiClient.post<QueueParseResponse>(
        `/sessions/${sessionId}/parse`,
        { fileIds: parseableFileIds },
      );
      const parsedResponse = await apiClient.get<ParsedStatementItem[]>(`/sessions/${sessionId}/parsed`);
      setParsedStatements(parsedResponse ?? []);
      const trackedFileIds = response.queued.map((item) => item.fileId).filter((fileId) => fileId.length > 0);
      if (trackedFileIds.length > 0) {
        setParseTrackingFileIds((current) => [...new Set([...current, ...trackedFileIds])]);
        if (parseMonitorStartedAt === null) {
          setParseMonitorStartedAt(Date.now());
        }
        setParseMonitorNow(Date.now());
      }

      const message = `Queued ${response.queued.length} file${response.queued.length === 1 ? '' : 's'} for parsing.`;
      setSuccessMessage(message);
      showToast(message, 'success');

      if (response.skipped.length > 0) {
        const skippedMessage = `${response.skipped.length} selected file${response.skipped.length === 1 ? ' was' : 's were'} skipped.`;
        setErrorMessage(skippedMessage);
      }
      if ((response.deferred?.length ?? 0) > 0) {
        const deferredMessage = `${response.deferred?.length} file${response.deferred?.length === 1 ? '' : 's'} queued for background parsing.`;
        showToast(deferredMessage, 'info');
      }
    } catch {
      const message = 'Unable to queue parsing right now.';
      setErrorMessage(message);
      showToast(message, 'error');
    } finally {
      setIsQueueingParse(false);
    }
  }

  async function handleRecalculate() {
    if (!sessionId) {
      setErrorMessage('Missing session ID.');
      return;
    }

    if (!hasAccessToken) {
      setErrorMessage('To access this page, continue via email link.');
      return;
    }

    setIsRecalculating(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const [groupedFilesResponse, parsedResponse] = await Promise.all([
        apiClient.get<GroupedSessionFilesResponse>(`/sessions/${sessionId}/files?grouped=true`),
        apiClient.get<ParsedStatementItem[]>(`/sessions/${sessionId}/parsed`),
      ]);

      const normalizedGroupedFiles = normalizeGroupedFiles(groupedFilesResponse);
      setFilesByAccount(normalizedGroupedFiles);
      setParsedStatements(parsedResponse ?? []);
      setTransactionsByFileId({});

      const nextSelectableIds = [
        ...normalizedGroupedFiles.credit,
        ...normalizedGroupedFiles.checking,
        ...normalizedGroupedFiles.savings,
      ].map((file) => file.id);
      const parsedSelectableIdSet = new Set(
        (parsedResponse ?? [])
          .filter((entry) => entry.status === 'parsed')
          .map((entry) => entry.fileId),
      );

      setSelectedFileIds((current) => current.filter((fileId) => nextSelectableIds.includes(fileId) && parsedSelectableIdSet.has(fileId)));
      setLastRecalculatedAt(new Date().toISOString());
      showToast('Insights recalculated from selected parsed files.', 'success');
    } catch {
      const message = 'Unable to recalculate insights right now.';
      setErrorMessage(message);
      showToast(message, 'error');
    } finally {
      setIsRecalculating(false);
    }
  }

  return (
    <AppLayout>
      <h1>Statement Insights</h1>
      <p className="muted page-lead">Scaffold page for parsing and financial insights.</p>

      {errorMessage && <p className="text-error" role="alert">{errorMessage}</p>}
      {successMessage && <p className="text-success" role="status">{successMessage}</p>}

      <section className="card">
        <p><strong>Session ID:</strong> {sessionId ?? '-'}</p>
        <div className="actions">
          <button
            className="button"
            type="button"
            onClick={() => void handleQueueParse()}
            disabled={isLoading || isQueueingParse || isParseMonitoringActive || parseableFileIds.length === 0}
          >
            {isQueueingParse ? 'Queueing...' : isParseMonitoringActive ? 'Parsing...' : 'Parse statements'}
          </button>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => void handleRecalculate()}
            disabled={isLoading || isQueueingParse || isRecalculating}
          >
            {isRecalculating ? 'Recalculating...' : 'Recalculate'}
          </button>
        </div>
        {parseProgress && (
          <div className="insights-parse-progress" role="status" aria-live="polite">
            <div className="insights-parse-progress-head">
              <strong>Parsing progress</strong>
              <span>
                {parseProgress.completedCount}/{parseProgress.total} files complete ({parseProgress.percent}%)
              </span>
            </div>
            <div className="insights-parse-progress-track" aria-hidden="true">
              <span style={{ width: `${parseProgress.percent}%` }} />
            </div>
            <p className="muted">{parseProgress.etaLabel}</p>
            {(parseProgress.processingCount > 0 || parseProgress.pendingCount > 0 || parseProgress.queuedCount > 0) && (
              <p className="muted">
                {parseProgress.processingCount} processing, {parseProgress.pendingCount} pending
                {parseProgress.queuedCount > 0 ? `, ${parseProgress.queuedCount} queued` : ''}
              </p>
            )}
          </div>
        )}
        {lastRecalculatedAt && <p className="muted">Last recalculated: {formatDate(lastRecalculatedAt)}</p>}
      </section>

      <section className="card">
        <h2>Included Files</h2>
        <p className="muted">Default selection includes credit, checking, and savings. Root files are excluded.</p>
        {isLoading && <p role="status">Loading files...</p>}
        {!isLoading && (
          <div className="insights-groups">
            {(['credit', 'checking', 'savings'] as AccountType[]).map((accountType) => (
              <article className="result-box insights-group" key={accountType}>
                <h3>{ACCOUNT_TYPE_COPY[accountType].title}</h3>
                {filesByAccount[accountType].length === 0 && (
                  <div className="insights-empty-state">
                    <p><strong>{ACCOUNT_TYPE_COPY[accountType].emptyTitle}</strong></p>
                    <p className="muted">{ACCOUNT_TYPE_COPY[accountType].emptyDescription}</p>
                    <Link
                      className="button button-secondary insights-empty-cta"
                      to={`/sessions/${sessionId}`}
                    >
                      {ACCOUNT_TYPE_COPY[accountType].ctaLabel}
                    </Link>
                  </div>
                )}
                {filesByAccount[accountType].map((file) => (
                  (() => {
                    const parsedStatus = parsedByFileId.get(file.id)?.status ?? 'not_queued';
                    const canReviewLabels = parsedStatus === 'parsed';
                    const includeInCalculations = parsedStatus === 'parsed';
                    return (
                      <div className={`insights-file-row${includeInCalculations ? '' : ' is-disabled'}`} key={file.id}>
                        <input
                          className="session-select-input"
                          type="checkbox"
                          checked={selectedFileIds.includes(file.id)}
                          onChange={(event) => toggleSelectedFile(file.id, event.target.checked)}
                          disabled={!includeInCalculations}
                          title={includeInCalculations ? undefined : 'This file must be parsed before it can be included in calculations.'}
                        />
                        <span className="minw0">
                          <strong title={resolveDisplayName(file)}>{resolveDisplayName(file)}</strong>
                          <small className="muted">status: {file.status ?? 'uploaded'}</small>
                        </span>
                        <div className="insights-file-actions">
                          <button
                            className="insights-inline-action"
                            type="button"
                            onClick={() => void handleViewFile(file)}
                            disabled={viewingFileId === file.id}
                          >
                            {viewingFileId === file.id ? 'Opening...' : 'View file'}
                          </button>
                          {canReviewLabels ? (
                            <Link to={`/sessions/${sessionId}/files/${file.id}/labels`}>Review labels</Link>
                          ) : (
                            <span
                              className="insights-labels-disabled"
                              aria-disabled="true"
                              title="Parse this file first to review labels."
                            >
                              Review labels
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()
                ))}
              </article>
            ))}
            <article className="result-box insights-group">
              <h3>Root files (excluded)</h3>
              {filesByAccount.root.length === 0 && <p className="muted">No root files.</p>}
              {filesByAccount.root.map((file) => (
                <p className="muted break" key={file.id}>{resolveDisplayName(file)}</p>
              ))}
            </article>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Parse Status</h2>
        <p className="muted">Scaffold view of parsed statement records.</p>
        {selectableFiles.length > 0 && (
          <div className="insights-status-filters" role="group" aria-label="Filter by parse status">
            <button
              className={`insights-status-filter-button${selectedParseStatusFilters.length === 0 ? ' is-active' : ''}`}
              type="button"
              onClick={() => setSelectedParseStatusFilters([])}
            >
              All ({selectableFiles.length})
            </button>
            {parseStatusFilterOptions.map((status) => {
              const count = parseStatusCounts.get(status) ?? 0;
              const isActive = selectedParseStatusFilters.includes(status);
              return (
                <button
                  className={`insights-status-filter-button${isActive ? ' is-active' : ''}`}
                  type="button"
                  key={status}
                  onClick={() => toggleParseStatusFilter(status)}
                >
                  {formatStatusLabel(status)} ({count})
                </button>
              );
            })}
          </div>
        )}
        {selectableFiles.length === 0 && <p className="muted">No eligible files yet.</p>}
        {selectableFiles.length > 0 && filteredParseStatusFiles.length === 0 && (
          <p className="muted">No files match the selected status filters.</p>
        )}
        {filteredParseStatusFiles.length > 0 && (
          <div className="stack-md">
            {filteredParseStatusFiles.map((file) => {
              const parsed = parsedByFileId.get(file.id);
              return (
                <article className="result-box" key={file.id}>
                  <div className="insights-status-header">
                    <p><strong>{resolveDisplayName(file)}</strong></p>
                    <button
                      className="insights-inline-action"
                      type="button"
                      onClick={() => void handleViewFile(file)}
                      disabled={viewingFileId === file.id}
                    >
                      {viewingFileId === file.id ? 'Opening...' : 'View file'}
                    </button>
                  </div>
                  <p className="muted">status: {formatStatusLabel(parsed?.status ?? 'not_queued')}</p>
                  <p className="muted">updated: {formatDate(parsed?.updatedAt)}</p>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Summary Cards</h2>
        <p className="muted">Calculated from selected parsed credit/checking/savings files.</p>
        {pendingTransactionFileIds.length > 0 && (
          <p className="muted">
            Loading transactions for {pendingTransactionFileIds.length} file{pendingTransactionFileIds.length === 1 ? '' : 's'} to complete calculations and interest insights.
          </p>
        )}
        {calculationSummary.excludedNotParsedCount > 0 && (
          <p className="text-warning">
            {calculationSummary.excludedNotParsedCount} selected file{calculationSummary.excludedNotParsedCount === 1 ? '' : 's'} excluded because parse status is not `parsed`.
          </p>
        )}
        <div className="insights-summary-grid">
          <article className="result-box">
            <h3>Total Debt</h3>
            <p className="insights-metric-value">{formatCurrency(calculationSummary.debtTotal)}</p>
            <p className="muted">
              {calculationSummary.creditFileCount} credit file{calculationSummary.creditFileCount === 1 ? '' : 's'} included.
            </p>
            {calculationSummary.usedCreditFallbackCount > 0 && (
              <p className="muted">
                {calculationSummary.usedCreditFallbackCount} file{calculationSummary.usedCreditFallbackCount === 1 ? '' : 's'} inferred from transactions (no closing balance detected).
              </p>
            )}
          </article>
          <article className="result-box">
            <h3>Total Savings</h3>
            <p className="insights-metric-value">{formatCurrency(calculationSummary.savingsTotal)}</p>
            <p className="muted">
              {calculationSummary.savingsFileCount} savings file{calculationSummary.savingsFileCount === 1 ? '' : 's'} included.
            </p>
          </article>
          <article className="result-box">
            <h3>6-Month Target</h3>
            <p className="insights-metric-value">{formatCurrency(calculationSummary.target6mo)}</p>
            <p className="muted">
              Monthly expenses estimate: {formatCurrency(calculationSummary.expenseMonthly)} (last {MONTHLY_EXPENSE_WINDOW} month window).
            </p>
            <p className="muted">
              {calculationSummary.checkingFileCount} checking file{calculationSummary.checkingFileCount === 1 ? '' : 's'} included.
            </p>
          </article>
          <article className="result-box">
            <h3>{calculationSummary.gap < 0 ? 'Surplus' : 'Gap'}</h3>
            <p className="insights-metric-value">
              {formatCurrency(Math.abs(calculationSummary.gap))}
            </p>
            <p className="muted">
              {calculationSummary.gap < 0
                ? 'Savings exceed 6-month target.'
                : 'Additional savings needed to reach 6-month target.'}
            </p>
          </article>
        </div>
      </section>

      <section className="card">
        <h2>Interest Insights</h2>
        <p className="muted">Credit interest paid and checking/savings interest collected from selected parsed files.</p>
        <p className="insights-metric-value">{formatCurrency(interestInsights.interestPaidTotal)}</p>
        <p className="muted">
          Interest paid total across {interestInsights.fileCount} credit file{interestInsights.fileCount === 1 ? '' : 's'}.
        </p>
        {interestInsights.creditRows.length === 0 && (
          <p className="muted">No parsed credit files are currently selected.</p>
        )}
        {interestInsights.creditRows.length > 0 && (
          <div className="insights-interest-table-wrap">
            <table className="insights-interest-table">
              <thead>
                <tr>
                  <th scope="col">Statement</th>
                  <th scope="col">Interest Charged</th>
                  <th scope="col">APR</th>
                  <th scope="col">Min Payment</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {interestInsights.creditRows.map((row) => (
                  <tr key={row.fileId}>
                    <td className="break" title={row.displayName}>{row.displayName}</td>
                    <td>{row.interestCharged === null ? '-' : formatCurrency(row.interestCharged)}</td>
                    <td>{row.apr === null ? '-' : formatPercent(row.apr)}</td>
                    <td>{row.minPayment === null ? '-' : formatCurrency(row.minPayment)}</td>
                    <td>
                      {row.hasDetectedInterestDetails
                        ? 'Detected'
                        : 'Interest not detected on this statement (needs review).'}
                    </td>
                    <td>
                      {row.hasDetectedInterestDetails ? (
                        <button
                          className="insights-inline-action"
                          type="button"
                          onClick={() => void handleViewFile({ id: row.fileId, originalName: row.displayName })}
                          disabled={viewingFileId === row.fileId}
                        >
                          {viewingFileId === row.fileId ? 'Opening...' : 'View file'}
                        </button>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {interestInsights.missingDetailsCount > 0 && (
          <p className="muted">
            {interestInsights.missingDetailsCount} credit statement{interestInsights.missingDetailsCount === 1 ? '' : 's'} missing interest details.
          </p>
        )}

        <h3 className="insights-interest-section-title">Interest Collected (Checking/Savings)</h3>
        <p className="insights-metric-value">{formatCurrency(interestInsights.interestCollectedTotal)}</p>
        <p className="muted">
          Interest collected total across {interestInsights.depositFileCount} checking/savings file{interestInsights.depositFileCount === 1 ? '' : 's'}.
        </p>
        <h3 className="insights-interest-section-title">Checking Accounts</h3>
        <p className="insights-metric-value">{formatCurrency(interestInsights.checkingInterestCollectedTotal)}</p>
        <p className="muted">
          Interest collected across {interestInsights.checkingFileCount} checking file{interestInsights.checkingFileCount === 1 ? '' : 's'}.
        </p>
        <div className="insights-interest-table-wrap">
          <table className="insights-interest-table">
            <thead>
              <tr>
                <th scope="col">Statement</th>
                <th scope="col">Interest Collected</th>
                <th scope="col">Source</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {interestInsights.checkingRows.length === 0 && (
                <tr>
                  <td className="muted" colSpan={5}>No parsed checking files are currently selected.</td>
                </tr>
              )}
              {interestInsights.checkingRows.map((row) => (
                <tr key={row.fileId}>
                  <td className="break" title={row.displayName}>{row.displayName}</td>
                  <td>{row.interestCollected === null ? '-' : formatCurrency(row.interestCollected)}</td>
                  <td>{row.sourceLabel}</td>
                  <td>
                    {row.interestCollected === null
                      ? 'Interest not detected on this statement (needs review).'
                      : 'Detected'}
                  </td>
                  <td>
                    {row.interestCollected !== null ? (
                      <button
                        className="insights-inline-action"
                        type="button"
                        onClick={() => void handleViewFile({ id: row.fileId, originalName: row.displayName })}
                        disabled={viewingFileId === row.fileId}
                      >
                        {viewingFileId === row.fileId ? 'Opening...' : 'View file'}
                      </button>
                    ) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {interestInsights.missingCheckingCollectedCount > 0 && (
          <p className="muted">
            {interestInsights.missingCheckingCollectedCount} checking statement{interestInsights.missingCheckingCollectedCount === 1 ? '' : 's'} missing collected interest details.
          </p>
        )}

        <h3 className="insights-interest-section-title">Savings Accounts</h3>
        <p className="insights-metric-value">{formatCurrency(interestInsights.savingsInterestCollectedTotal)}</p>
        <p className="muted">
          Interest collected across {interestInsights.savingsFileCount} savings file{interestInsights.savingsFileCount === 1 ? '' : 's'}.
        </p>
        <div className="insights-interest-table-wrap">
          <table className="insights-interest-table">
            <thead>
              <tr>
                <th scope="col">Statement</th>
                <th scope="col">Interest Collected</th>
                <th scope="col">Source</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {interestInsights.savingsRows.length === 0 && (
                <tr>
                  <td className="muted" colSpan={5}>No parsed savings files are currently selected.</td>
                </tr>
              )}
              {interestInsights.savingsRows.map((row) => (
                <tr key={row.fileId}>
                  <td className="break" title={row.displayName}>{row.displayName}</td>
                  <td>{row.interestCollected === null ? '-' : formatCurrency(row.interestCollected)}</td>
                  <td>{row.sourceLabel}</td>
                  <td>
                    {row.interestCollected === null
                      ? 'Interest not detected on this statement (needs review).'
                      : 'Detected'}
                  </td>
                  <td>
                    {row.interestCollected !== null ? (
                      <button
                        className="insights-inline-action"
                        type="button"
                        onClick={() => void handleViewFile({ id: row.fileId, originalName: row.displayName })}
                        disabled={viewingFileId === row.fileId}
                      >
                        {viewingFileId === row.fileId ? 'Opening...' : 'View file'}
                      </button>
                    ) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {interestInsights.missingSavingsCollectedCount > 0 && (
          <p className="muted">
            {interestInsights.missingSavingsCollectedCount} savings statement{interestInsights.missingSavingsCollectedCount === 1 ? '' : 's'} missing collected interest details.
          </p>
        )}
        {interestInsights.missingCollectedCount > 0 && (
          <p className="muted">
            {interestInsights.missingCollectedCount} checking/savings statement{interestInsights.missingCollectedCount === 1 ? '' : 's'} missing collected interest details.
          </p>
        )}
      </section>

      <nav className="actions">
        <Link to={`/sessions/${sessionId}`}>Back to session dashboard</Link>
        <Link to="/sessions">Back to sessions</Link>
      </nav>

      <SessionExpiryExtendDialogManager
        sessionId={sessionId}
        expiresAt={sessionExpiresAt}
        hasAccessToken={hasAccessToken}
        onExtended={(nextExpiresAt) => {
          setSessionExpiresAt(nextExpiresAt);
          setSessionRefreshKey((current) => current + 1);
        }}
      />
    </AppLayout>
  );
}
