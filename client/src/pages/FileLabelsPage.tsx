import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, apiClient, getAccessToken } from '../api';
import { AppLayout } from '../ui/AppLayout';
import { SessionExpiryExtendDialogManager } from '../ui/SessionExpiryExtendDialogManager';
import { useToast } from '../ui/toast-provider';

interface TransactionItem {
  id: string;
  txnDate?: string;
  accountType?: 'credit' | 'checking' | 'savings';
  descriptionRaw?: string;
  descriptionNormalized?: string;
  amount?: number;
  labelIds?: string[];
  suggestedLabels?: SuggestedLabel[];
}

interface LabelOption {
  id: string;
  name: string;
  type?: 'custom' | 'system' | string;
  isIncome?: boolean;
  color?: string;
}

type DirectionFilter = 'all' | 'in' | 'out';
type RuleApplyMode = 'suggest' | 'auto';

interface SuggestedLabel {
  labelId: string;
  applyMode?: RuleApplyMode;
}

interface SessionDetailsResponse {
  sessionId: string;
  expiresAt?: string;
}

const DIRECTION_FILTER_OPTIONS: Array<{ value: DirectionFilter; label: string }> = [
  { value: 'all', label: 'All amounts' },
  { value: 'in', label: 'Money in' },
  { value: 'out', label: 'Money out' },
];

const RULE_TOKEN_STOP_WORDS = new Set([
  'A',
  'AN',
  'AND',
  'AT',
  'FOR',
  'FROM',
  'IN',
  'OF',
  'ON',
  'OR',
  'PAYMENT',
  'POS',
  'PURCHASE',
  'THE',
  'TO',
  'WITH',
]);

function formatDate(value?: string): string {
  if (!value) {
    return '-';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString();
}

function formatAmount(value?: number): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '-';
  }

  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
  });
}

function amountMatchesDirection(amount: number | undefined, direction: DirectionFilter): boolean {
  if (direction === 'all') {
    return true;
  }

  if (typeof amount !== 'number' || Number.isNaN(amount)) {
    return false;
  }

  if (direction === 'in') {
    return amount > 0;
  }

  return amount < 0;
}

function normalizeLabelName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeDescriptionForRule(value: string | undefined): string {
  if (!value) {
    return '';
  }

  return value
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractKeyTokens(normalizedDescription: string): string[] {
  const uniqueTokens = new Set<string>();
  normalizedDescription.split(' ').forEach((token) => {
    if (token.length < 3) {
      return;
    }
    if (RULE_TOKEN_STOP_WORDS.has(token)) {
      return;
    }
    uniqueTokens.add(token);
  });
  return [...uniqueTokens].slice(0, 6);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toDirectionLabel(amount: number | undefined): 'in' | 'out' | 'unknown' {
  if (typeof amount !== 'number' || Number.isNaN(amount) || amount === 0) {
    return 'unknown';
  }
  return amount > 0 ? 'in' : 'out';
}

function escapeCsvCell(value: string): string {
  if (!/[",\n]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }

  const payload = error.payload;
  if (typeof payload === 'string' && payload.trim().length > 0) {
    return payload;
  }

  if (payload && typeof payload === 'object' && 'message' in payload) {
    const message = (payload as { message?: string | string[] }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
    if (Array.isArray(message) && typeof message[0] === 'string' && message[0].trim().length > 0) {
      return message[0];
    }
  }

  return fallback;
}

export function FileLabelsPage() {
  const { sessionId, fileId } = useParams();
  const { showToast } = useToast();
  const hasAccessToken = Boolean(getAccessToken());

  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [labels, setLabels] = useState<LabelOption[]>([]);
  const [txnLabelIdsById, setTxnLabelIdsById] = useState<Record<string, string[]>>({});
  const [txnSuggestedLabelsById, setTxnSuggestedLabelsById] = useState<Record<string, SuggestedLabel[]>>({});
  const [selectedTxnIds, setSelectedTxnIds] = useState<string[]>([]);
  const [selectedLabelByTxnId, setSelectedLabelByTxnId] = useState<Record<string, string>>({});
  const [newLabelDraftByTxnId, setNewLabelDraftByTxnId] = useState<Record<string, string>>({});
  const [bulkSelectedLabelId, setBulkSelectedLabelId] = useState('');
  const [bulkNewLabelDraft, setBulkNewLabelDraft] = useState('');
  const [applySimilarByTxnId, setApplySimilarByTxnId] = useState<Record<string, boolean>>({});
  const [ruleApplyModeByTxnId, setRuleApplyModeByTxnId] = useState<Record<string, RuleApplyMode>>(
    {},
  );
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [labelFilterId, setLabelFilterId] = useState('all');
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [busyTxnId, setBusyTxnId] = useState<string | null>(null);
  const [isBulkApplying, setIsBulkApplying] = useState(false);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);

  useEffect(() => {
    if (!sessionId || !fileId) {
      setErrorMessage('Missing session or file ID.');
      setIsLoading(false);
      return;
    }

    if (!hasAccessToken) {
      setErrorMessage('To access this page, continue via email link.');
      setIsLoading(false);
      return;
    }

    const targetFileId = fileId;
    let cancelled = false;
    const controller = new AbortController();

    async function loadTransactions() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const [sessionDetails, transactionsResponse, labelsResponse] = await Promise.all([
          apiClient.get<SessionDetailsResponse>(`/sessions/${sessionId}`, { signal: controller.signal }),
          apiClient.get<TransactionItem[]>(
            `/sessions/${sessionId}/transactions?fileId=${encodeURIComponent(targetFileId)}`,
            { signal: controller.signal },
          ),
          apiClient.get<LabelOption[]>('/labels', { signal: controller.signal }),
        ]);
        if (!cancelled) {
          setSessionExpiresAt(sessionDetails.expiresAt ?? null);
          setTransactions(transactionsResponse ?? []);
          setLabels(labelsResponse ?? []);
          setTxnLabelIdsById((current) => {
            const next: Record<string, string[]> = {};
            (transactionsResponse ?? []).forEach((txn) => {
              const fromApi = Array.isArray(txn.labelIds)
                ? txn.labelIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
                : [];
              next[txn.id] = fromApi.length > 0 ? fromApi : (current[txn.id] ?? []);
            });
            return next;
          });
          setTxnSuggestedLabelsById(() => {
            const next: Record<string, SuggestedLabel[]> = {};
            (transactionsResponse ?? []).forEach((txn) => {
              const suggestions = Array.isArray(txn.suggestedLabels)
                ? txn.suggestedLabels.filter((item): item is SuggestedLabel => (
                  Boolean(item)
                  && typeof item === 'object'
                  && typeof item.labelId === 'string'
                  && item.labelId.length > 0
                ))
                : [];
              next[txn.id] = suggestions;
            });
            return next;
          });
          setSelectedLabelByTxnId({});
          setNewLabelDraftByTxnId({});
          setSelectedTxnIds([]);
          setBulkSelectedLabelId('');
          setBulkNewLabelDraft('');
          setApplySimilarByTxnId({});
          setRuleApplyModeByTxnId({});
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
        const message = 'Unable to load transactions right now.';
        setErrorMessage(message);
        showToast(message, 'error');
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadTransactions();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fileId, hasAccessToken, sessionId, sessionRefreshKey, showToast]);

  const labelsById = useMemo(() => {
    const map = new Map<string, LabelOption>();
    labels.forEach((label) => map.set(label.id, label));
    return map;
  }, [labels]);

  const sortedLabels = useMemo(
    () => [...labels].sort((left, right) => left.name.localeCompare(right.name)),
    [labels],
  );

  const filteredTransactions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return transactions.filter((txn) => {
      if (query && !(txn.descriptionRaw ?? '').toLowerCase().includes(query)) {
        return false;
      }

      if (!amountMatchesDirection(txn.amount, directionFilter)) {
        return false;
      }

      if (labelFilterId === 'all') {
        return true;
      }

      const labelIds = txnLabelIdsById[txn.id] ?? [];
      return labelIds.includes(labelFilterId);
    });
  }, [directionFilter, labelFilterId, searchQuery, transactions, txnLabelIdsById]);

  const transactionsById = useMemo(() => {
    const map = new Map<string, TransactionItem>();
    transactions.forEach((txn) => {
      map.set(txn.id, txn);
    });
    return map;
  }, [transactions]);

  const selectedTxnIdSet = useMemo(
    () => new Set(selectedTxnIds),
    [selectedTxnIds],
  );

  const filteredTxnIds = useMemo(
    () => filteredTransactions.map((txn) => txn.id),
    [filteredTransactions],
  );

  const selectedFilteredCount = useMemo(
    () => filteredTxnIds.filter((id) => selectedTxnIdSet.has(id)).length,
    [filteredTxnIds, selectedTxnIdSet],
  );

  const allFilteredSelected = filteredTxnIds.length > 0 && selectedFilteredCount === filteredTxnIds.length;

  useEffect(() => {
    setSelectedTxnIds((current) =>
      current.filter((id) => transactions.some((txn) => txn.id === id)),
    );
  }, [transactions]);

  function addLabelIdToTransaction(txnId: string, labelId: string): void {
    setTxnLabelIdsById((current) => {
      const existing = current[txnId] ?? [];
      if (existing.includes(labelId)) {
        return current;
      }

      return {
        ...current,
        [txnId]: [...existing, labelId],
      };
    });
  }

  function removeSuggestedLabel(txnId: string, labelId: string): void {
    setTxnSuggestedLabelsById((current) => ({
      ...current,
      [txnId]: (current[txnId] ?? []).filter((suggested) => suggested.labelId !== labelId),
    }));
  }

  function removeLabelIdFromTransaction(txnId: string, labelId: string): void {
    setTxnLabelIdsById((current) => ({
      ...current,
      [txnId]: (current[txnId] ?? []).filter((currentId) => currentId !== labelId),
    }));
  }

  function toggleTxnSelection(txnId: string): void {
    setSelectedTxnIds((current) => (
      current.includes(txnId)
        ? current.filter((id) => id !== txnId)
        : [...current, txnId]
    ));
  }

  function toggleSelectAllFiltered(): void {
    setSelectedTxnIds((current) => {
      if (allFilteredSelected) {
        return current.filter((id) => !filteredTxnIds.includes(id));
      }
      const next = new Set(current);
      filteredTxnIds.forEach((id) => next.add(id));
      return [...next];
    });
  }

  function clearSelectedTransactions(): void {
    setSelectedTxnIds([]);
  }

  async function createOrGetLabel(rawName: string): Promise<LabelOption | null> {
    const normalized = normalizeLabelName(rawName);
    if (!normalized) {
      return null;
    }

    const existing = labels.find((label) => normalizeLabelName(label.name).toLowerCase() === normalized.toLowerCase());
    if (existing) {
      return existing;
    }

    const created = await apiClient.post<LabelOption>('/labels', {
      name: normalized,
      type: 'custom',
      isIncome: false,
    });
    setLabels((current) => {
      const alreadyExists = current.some((label) => label.id === created.id);
      if (alreadyExists) {
        return current;
      }
      return [...current, created];
    });
    return created;
  }

  async function maybeCreateLabelRule(txnId: string, labelId: string): Promise<boolean> {
    if (!applySimilarByTxnId[txnId]) {
      return false;
    }

    const txn = transactionsById.get(txnId);
    if (!txn) {
      return false;
    }

    const normalizedDescription = normalizeDescriptionForRule(
      txn.descriptionNormalized ?? txn.descriptionRaw,
    );
    const descriptionContains = extractKeyTokens(normalizedDescription);
    const descriptionRegex = normalizedDescription
      ? `\\b${normalizedDescription
          .split(' ')
          .map((token) => escapeRegexLiteral(token))
          .join('\\s+')}\\b`
      : undefined;

    const match: {
      descriptionContains?: string[];
      descriptionRegex?: string;
      direction?: 'in' | 'out';
      accountType?: 'credit' | 'checking' | 'savings';
    } = {};
    if (descriptionContains.length > 0) {
      match.descriptionContains = descriptionContains;
    } else if (descriptionRegex) {
      match.descriptionRegex = descriptionRegex;
    } else {
      throw new Error('Unable to create a similar-transaction rule without a description.');
    }

    if (typeof txn.amount === 'number' && !Number.isNaN(txn.amount) && txn.amount !== 0) {
      match.direction = txn.amount > 0 ? 'in' : 'out';
    }

    if (
      txn.accountType === 'credit'
      || txn.accountType === 'checking'
      || txn.accountType === 'savings'
    ) {
      match.accountType = txn.accountType;
    }

    await apiClient.post('/label-rules', {
      labelId,
      match,
      applyMode: ruleApplyModeByTxnId[txnId] ?? 'suggest',
    });
    return true;
  }

  async function handleAddExistingLabel(txnId: string): Promise<void> {
    const labelId = selectedLabelByTxnId[txnId];
    if (!labelId) {
      showToast('Select a label before adding.', 'error');
      return;
    }

    setBusyTxnId(txnId);
    try {
      await apiClient.post(`/transactions/${txnId}/labels`, { labelId });
      addLabelIdToTransaction(txnId, labelId);
      const createdRule = await maybeCreateLabelRule(txnId, labelId);
      setSelectedLabelByTxnId((current) => ({
        ...current,
        [txnId]: '',
      }));
      showToast(
        createdRule ? 'Label attached and similar-transaction rule saved.' : 'Label attached.',
        'success',
      );
    } catch (error) {
      showToast(getApiErrorMessage(error, 'Unable to attach label right now.'), 'error');
    } finally {
      setBusyTxnId((current) => (current === txnId ? null : current));
    }
  }

  async function handleCreateInlineLabel(txnId: string): Promise<void> {
    setBusyTxnId(txnId);
    try {
      const createdLabel = await createOrGetLabel(newLabelDraftByTxnId[txnId] ?? '');
      if (!createdLabel) {
        showToast('Enter a label name to create.', 'error');
        return;
      }

      await apiClient.post(`/transactions/${txnId}/labels`, { labelId: createdLabel.id });
      addLabelIdToTransaction(txnId, createdLabel.id);
      const createdRule = await maybeCreateLabelRule(txnId, createdLabel.id);
      setNewLabelDraftByTxnId((current) => ({
        ...current,
        [txnId]: '',
      }));
      setSelectedLabelByTxnId((current) => ({
        ...current,
        [txnId]: '',
      }));
      showToast(
        createdRule
          ? 'Label created, attached, and similar-transaction rule saved.'
          : 'Label created and attached.',
        'success',
      );
    } catch (error) {
      showToast(getApiErrorMessage(error, 'Unable to create/attach label right now.'), 'error');
    } finally {
      setBusyTxnId((current) => (current === txnId ? null : current));
    }
  }

  async function handleRemoveLabel(txnId: string, labelId: string): Promise<void> {
    setBusyTxnId(txnId);
    try {
      await apiClient.delete(`/transactions/${txnId}/labels/${labelId}`);
      removeLabelIdFromTransaction(txnId, labelId);
      showToast('Label removed.', 'success');
    } catch (error) {
      showToast(getApiErrorMessage(error, 'Unable to remove label right now.'), 'error');
    } finally {
      setBusyTxnId((current) => (current === txnId ? null : current));
    }
  }

  async function handleApplySuggestedLabel(txnId: string, labelId: string): Promise<void> {
    setBusyTxnId(txnId);
    try {
      await apiClient.post(`/transactions/${txnId}/labels`, { labelId });
      addLabelIdToTransaction(txnId, labelId);
      removeSuggestedLabel(txnId, labelId);
      showToast('Suggested label applied.', 'success');
    } catch (error) {
      showToast(getApiErrorMessage(error, 'Unable to apply suggested label right now.'), 'error');
    } finally {
      setBusyTxnId((current) => (current === txnId ? null : current));
    }
  }

  async function applyLabelToTransactions(txnIds: string[], labelId: string): Promise<void> {
    if (txnIds.length === 0) {
      showToast('Select one or more transactions first.', 'error');
      return;
    }

    setIsBulkApplying(true);
    try {
      const results = await Promise.allSettled(
        txnIds.map(async (txnId) => {
          await apiClient.post(`/transactions/${txnId}/labels`, { labelId });
          return txnId;
        }),
      );

      const attachedTxnIds: string[] = [];
      let failedCount = 0;
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          attachedTxnIds.push(result.value);
          return;
        }
        failedCount += 1;
      });

      attachedTxnIds.forEach((txnId) => {
        addLabelIdToTransaction(txnId, labelId);
        removeSuggestedLabel(txnId, labelId);
      });

      if (failedCount === 0) {
        showToast(
          `Applied label to ${attachedTxnIds.length} transaction${attachedTxnIds.length === 1 ? '' : 's'}.`,
          'success',
        );
      } else if (attachedTxnIds.length === 0) {
        showToast('Unable to apply label to selected transactions.', 'error');
      } else {
        showToast(
          `Applied label to ${attachedTxnIds.length} transaction${attachedTxnIds.length === 1 ? '' : 's'}; ${failedCount} failed.`,
          'error',
        );
      }
    } catch (error) {
      showToast(getApiErrorMessage(error, 'Unable to apply label to selected transactions.'), 'error');
    } finally {
      setIsBulkApplying(false);
    }
  }

  async function handleBulkApplyExistingLabel(): Promise<void> {
    if (!bulkSelectedLabelId) {
      showToast('Choose a label first.', 'error');
      return;
    }

    await applyLabelToTransactions(selectedTxnIds, bulkSelectedLabelId);
  }

  async function handleBulkCreateAndApplyLabel(): Promise<void> {
    try {
      const createdLabel = await createOrGetLabel(bulkNewLabelDraft);
      if (!createdLabel) {
        showToast('Enter a label name to create.', 'error');
        return;
      }

      setBulkNewLabelDraft('');
      setBulkSelectedLabelId(createdLabel.id);
      await applyLabelToTransactions(selectedTxnIds, createdLabel.id);
    } catch (error) {
      showToast(getApiErrorMessage(error, 'Unable to create bulk label right now.'), 'error');
    }
  }

  function handleExportFilteredCsv(): void {
    if (filteredTransactions.length === 0) {
      showToast('No transactions to export.', 'info');
      return;
    }

    const header = ['transactionId', 'date', 'description', 'amount', 'direction', 'labels', 'suggestedLabels'];
    const rows = filteredTransactions.map((txn) => {
      const labelNames = (txnLabelIdsById[txn.id] ?? [])
        .map((labelId) => labelsById.get(labelId)?.name)
        .filter((value): value is string => Boolean(value))
        .join('; ');
      const suggestedNames = (txnSuggestedLabelsById[txn.id] ?? [])
        .map((suggestion) => labelsById.get(suggestion.labelId)?.name)
        .filter((value): value is string => Boolean(value))
        .join('; ');

      return [
        txn.id,
        formatDate(txn.txnDate),
        txn.descriptionRaw ?? '',
        typeof txn.amount === 'number' ? txn.amount.toFixed(2) : '',
        toDirectionLabel(txn.amount),
        labelNames,
        suggestedNames,
      ];
    });

    const csv = [header, ...rows]
      .map((row) => row.map((cell) => escapeCsvCell(String(cell))).join(','))
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeSessionId = (sessionId ?? 'session').replace(/[^A-Za-z0-9_-]/g, '-');
    const safeFileId = (fileId ?? 'file').replace(/[^A-Za-z0-9_-]/g, '-');
    link.href = objectUrl;
    link.download = `transactions-${safeSessionId}-${safeFileId}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
    showToast('CSV exported.', 'success');
  }

  return (
    <AppLayout>
      <h1>Transaction Labels</h1>
      <p className="muted page-lead">Review statement transactions and apply one or more labels.</p>

      {errorMessage && <p className="text-error" role="alert">{errorMessage}</p>}

      <section className="card">
        <p><strong>Session ID:</strong> {sessionId ?? '-'}</p>
        <p><strong>File ID:</strong> {fileId ?? '-'}</p>
        <div className="labels-top-filters">
          <label className="field">
            <span>Search transactions</span>
            <input
              className="input"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search by description"
            />
          </label>
          <label className="field">
            <span>Filter by label</span>
            <select
              className="input"
              value={labelFilterId}
              onChange={(event) => setLabelFilterId(event.target.value)}
            >
              <option value="all">All labels</option>
              {sortedLabels.map((label) => (
                <option key={label.id} value={label.id}>{label.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Filter by direction</span>
            <select
              className="input"
              value={directionFilter}
              onChange={(event) => setDirectionFilter(event.target.value as DirectionFilter)}
            >
              {DIRECTION_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Review Transactions</h2>
        <p className="muted">Add existing labels, create labels inline, and remove chips as needed.</p>
        <div className="labels-toolbar">
          <div className="labels-toolbar-row">
            <p className="muted">
              {selectedTxnIds.length} selected
              {filteredTransactions.length > 0 ? ` (${selectedFilteredCount} in current view)` : ''}
            </p>
            <button
              type="button"
              className="button button-secondary"
              onClick={handleExportFilteredCsv}
              disabled={isLoading || filteredTransactions.length === 0}
            >
              Export Filtered CSV
            </button>
          </div>
          <div className="labels-bulk-controls">
            <div className="labels-add-existing">
              <select
                className="input"
                value={bulkSelectedLabelId}
                onChange={(event) => setBulkSelectedLabelId(event.target.value)}
                disabled={isBulkApplying || selectedTxnIds.length === 0}
              >
                <option value="">Bulk label</option>
                {sortedLabels.map((label) => (
                  <option key={`bulk-${label.id}`} value={label.id}>{label.name}</option>
                ))}
              </select>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => void handleBulkApplyExistingLabel()}
                disabled={isBulkApplying || selectedTxnIds.length === 0 || !bulkSelectedLabelId}
              >
                {isBulkApplying ? 'Applying...' : 'Apply to Selected'}
              </button>
            </div>
            <div className="labels-add-new">
              <input
                className="input"
                value={bulkNewLabelDraft}
                onChange={(event) => setBulkNewLabelDraft(event.target.value)}
                placeholder="Create label for selected"
                disabled={isBulkApplying || selectedTxnIds.length === 0}
              />
              <button
                className="button"
                type="button"
                onClick={() => void handleBulkCreateAndApplyLabel()}
                disabled={
                  isBulkApplying
                  || selectedTxnIds.length === 0
                  || normalizeLabelName(bulkNewLabelDraft).length === 0
                }
              >
                {isBulkApplying ? 'Applying...' : 'Create + Apply'}
              </button>
            </div>
            <button
              className="button button-secondary"
              type="button"
              onClick={clearSelectedTransactions}
              disabled={isBulkApplying || selectedTxnIds.length === 0}
            >
              Clear Selection
            </button>
          </div>
        </div>

        {isLoading && <p role="status">Loading transactions...</p>}
        {!isLoading && filteredTransactions.length === 0 && (
          <>
            <p className="muted">
              No transactions matched your filters.
            </p>
            {transactions.length === 0 && (
              <p className="muted">
                No parsed transactions for this file yet. Run parse first from{' '}
                <Link to={`/sessions/${sessionId}/insights`}>Statement Insights</Link>.
              </p>
            )}
          </>
        )}

        {!isLoading && filteredTransactions.length > 0 && (
          <div className="labels-table-wrap">
            <table className="labels-table">
              <thead>
                <tr>
                  <th scope="col">
                    <label className="labels-select-all">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={() => toggleSelectAllFiltered()}
                        disabled={isBulkApplying}
                      />
                      <span>Select</span>
                    </label>
                  </th>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Labels</th>
                  <th scope="col">Add Label</th>
                </tr>
              </thead>
              <tbody>
                {filteredTransactions.map((txn) => {
                  const selectedLabelId = selectedLabelByTxnId[txn.id] ?? '';
                  const transactionLabelIds = txnLabelIdsById[txn.id] ?? [];
                  const transactionSuggestions = (txnSuggestedLabelsById[txn.id] ?? [])
                    .filter((suggested) => !transactionLabelIds.includes(suggested.labelId));
                  return (
                    <tr key={txn.id}>
                      <td className="labels-select-cell">
                        <input
                          type="checkbox"
                          className="labels-row-select"
                          checked={selectedTxnIdSet.has(txn.id)}
                          onChange={() => toggleTxnSelection(txn.id)}
                          disabled={isBulkApplying}
                        />
                      </td>
                      <td>{formatDate(txn.txnDate)}</td>
                      <td className="break" title={txn.descriptionRaw}>{txn.descriptionRaw || 'Transaction'}</td>
                      <td>{formatAmount(txn.amount)}</td>
                      <td>
                        <div className="labels-chip-wrap">
                          {transactionLabelIds.length === 0 && <span className="muted">No labels</span>}
                          {transactionLabelIds.map((labelId) => {
                            const label = labelsById.get(labelId);
                            if (!label) {
                              return null;
                            }
                            return (
                              <span className="labels-chip" key={`${txn.id}-${label.id}`}>
                                <span>{label.name}</span>
                                <button
                                  type="button"
                                  className="labels-chip-remove"
                                  aria-label={`Remove ${label.name} label`}
                                  onClick={() => void handleRemoveLabel(txn.id, label.id)}
                                  disabled={busyTxnId === txn.id || isBulkApplying}
                                >
                                  x
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td>
                        <div className="labels-add-controls">
                          <div className="labels-add-existing">
                            <select
                              className="input"
                              value={selectedLabelId}
                              onChange={(event) =>
                                setSelectedLabelByTxnId((current) => ({
                                  ...current,
                                  [txn.id]: event.target.value,
                                }))}
                            >
                              <option value="">Select label</option>
                              {sortedLabels.map((label) => (
                                <option key={label.id} value={label.id}>{label.name}</option>
                              ))}
                            </select>
                            <button
                              className="button button-secondary"
                              type="button"
                              onClick={() => void handleAddExistingLabel(txn.id)}
                              disabled={!selectedLabelId || busyTxnId === txn.id || isBulkApplying}
                            >
                              Add
                            </button>
                          </div>
                          <div className="labels-add-new">
                            <input
                              className="input"
                              value={newLabelDraftByTxnId[txn.id] ?? ''}
                              onChange={(event) =>
                                setNewLabelDraftByTxnId((current) => ({
                                  ...current,
                                  [txn.id]: event.target.value,
                                }))}
                              placeholder="Create label"
                            />
                            <button
                              className="button"
                              type="button"
                              onClick={() => void handleCreateInlineLabel(txn.id)}
                              disabled={
                                busyTxnId === txn.id
                                || isBulkApplying
                                || normalizeLabelName(newLabelDraftByTxnId[txn.id] ?? '').length === 0
                              }
                            >
                              Create + Add
                            </button>
                          </div>
                          <div className="labels-similar-controls">
                            <label className="labels-similar-checkbox">
                              <input
                                type="checkbox"
                                checked={Boolean(applySimilarByTxnId[txn.id])}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setApplySimilarByTxnId((current) => ({
                                    ...current,
                                    [txn.id]: checked,
                                  }));
                                  if (checked) {
                                    setRuleApplyModeByTxnId((current) => ({
                                      ...current,
                                      [txn.id]: current[txn.id] ?? 'suggest',
                                    }));
                                  }
                                }}
                                disabled={busyTxnId === txn.id || isBulkApplying}
                              />
                              <span>Apply to similar transactions?</span>
                            </label>
                            <label className="labels-similar-mode">
                              <span>Rule mode</span>
                              <select
                                className="input"
                                value={ruleApplyModeByTxnId[txn.id] ?? 'suggest'}
                                onChange={(event) =>
                                  setRuleApplyModeByTxnId((current) => ({
                                    ...current,
                                    [txn.id]: event.target.value as RuleApplyMode,
                                  }))}
                                disabled={!applySimilarByTxnId[txn.id] || busyTxnId === txn.id || isBulkApplying}
                              >
                                <option value="suggest">Suggest only (default)</option>
                                <option value="auto">Auto apply</option>
                              </select>
                            </label>
                          </div>
                          <div className="labels-suggestions">
                            <p className="labels-suggestions-title">Suggested labels</p>
                            {transactionSuggestions.length === 0 && (
                              <p className="muted labels-suggestions-empty">No suggestions</p>
                            )}
                            {transactionSuggestions.map((suggested) => {
                              const label = labelsById.get(suggested.labelId);
                              if (!label) {
                                return null;
                              }
                              const modeLabel = suggested.applyMode === 'auto' ? 'Auto rule' : 'Suggested';
                              return (
                                <div className="labels-suggestion-item" key={`${txn.id}-suggested-${label.id}`}>
                                  <span>{label.name} <small className="muted">({modeLabel})</small></span>
                                  <button
                                    type="button"
                                    className="button button-secondary"
                                    onClick={() => void handleApplySuggestedLabel(txn.id, label.id)}
                                    disabled={busyTxnId === txn.id || isBulkApplying}
                                  >
                                    Apply
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <nav className="actions">
        <Link to={`/sessions/${sessionId}/insights`}>Back to insights</Link>
        <Link to={`/sessions/${sessionId}`}>Back to session dashboard</Link>
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
