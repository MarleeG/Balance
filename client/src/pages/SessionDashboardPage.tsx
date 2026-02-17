import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../api';
import { AppLayout } from '../ui/AppLayout';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast-provider';

type StatementType = 'credit' | 'checking' | 'savings' | 'unknown';

interface FileRecordItem {
  id: string;
  originalName: string;
  statementType: StatementType;
  autoDetectedType?: StatementType;
  detectionConfidence?: number;
  isLikelyStatement?: boolean;
  size?: number;
  s3Key?: string;
  uploadedAt?: string;
}

interface UploadWarningItem {
  originalName: string;
  reason: string;
}

interface UploadRejectedItem {
  originalName: string;
  reason: string;
}

interface UploadResponse {
  uploaded: FileRecordItem[];
  rejected: UploadRejectedItem[];
  warnings?: UploadWarningItem[];
}

interface PendingUploadFile {
  localId: string;
  file: File;
  statementType: StatementType;
  warning?: string;
}

const MAX_FILES_PER_UPLOAD = 10;
const STATEMENT_TYPE_OPTIONS: StatementType[] = ['unknown', 'credit', 'checking', 'savings'];

function formatBytes(bytes?: number): string {
  if (!bytes || bytes < 0) {
    return '-';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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

function toStatementType(value: unknown): StatementType {
  if (value === 'credit' || value === 'checking' || value === 'savings' || value === 'unknown') {
    return value;
  }

  return 'unknown';
}

export function SessionDashboardPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [existingFiles, setExistingFiles] = useState<FileRecordItem[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingUploadFile[]>([]);
  const [typeDrafts, setTypeDrafts] = useState<Record<string, StatementType>>({});

  const [isLoadingFiles, setIsLoadingFiles] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [showDeleteSessionConfirm, setShowDeleteSessionConfirm] = useState(false);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [uploadWarnings, setUploadWarnings] = useState<UploadWarningItem[]>([]);
  const [uploadRejected, setUploadRejected] = useState<UploadRejectedItem[]>([]);

  useEffect(() => {
    if (!sessionId) {
      setErrorMessage('Missing session ID.');
      setIsLoadingFiles(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const loadFiles = async () => {
      setIsLoadingFiles(true);
      setErrorMessage(null);
      try {
        const response = await apiClient.get<FileRecordItem[]>(
          `/sessions/${sessionId}/files`,
          { signal: controller.signal },
        );
        if (cancelled) {
          return;
        }

        const normalized = response.map((item) => ({
          ...item,
          statementType: toStatementType(item.statementType),
          autoDetectedType: toStatementType(item.autoDetectedType),
        }));

        setExistingFiles(normalized);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        if (!cancelled) {
          setErrorMessage('Unable to load files for this session.');
          showToast('Unable to load files for this session.', 'error');
        }
      } finally {
        if (!cancelled) {
          setIsLoadingFiles(false);
        }
      }
    };

    loadFiles();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId, showToast]);

  const uploadableFiles = useMemo(
    () => pendingFiles.filter((item) => item.file.type === 'application/pdf'),
    [pendingFiles],
  );

  function onSelectFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';

    if (selected.length === 0) {
      return;
    }

    const allowed = selected.slice(0, MAX_FILES_PER_UPLOAD);
    const nextPending: PendingUploadFile[] = allowed.map((file, index) => ({
      localId: `${file.name}-${file.size}-${Date.now()}-${index}`,
      file,
      statementType: 'unknown',
      warning: file.type === 'application/pdf' ? undefined : 'Only PDF files can be uploaded.',
    }));

    setPendingFiles(nextPending);
    setUploadWarnings([]);
    setUploadRejected([]);
    setSuccessMessage(null);
    setErrorMessage(
      selected.length > MAX_FILES_PER_UPLOAD
        ? `Only the first ${MAX_FILES_PER_UPLOAD} files were kept for upload.`
        : null,
    );
  }

  function updatePendingType(localId: string, statementType: StatementType) {
    setPendingFiles((current) =>
      current.map((item) => (item.localId === localId ? { ...item, statementType } : item)));
  }

  async function handleUpload() {
    if (!sessionId) {
      setErrorMessage('Missing session ID.');
      return;
    }

    if (uploadableFiles.length === 0) {
      setErrorMessage('Select at least one PDF file to upload.');
      return;
    }

    setIsUploading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    const formData = new FormData();
    uploadableFiles.forEach((item) => formData.append('files', item.file));
    formData.append('meta', JSON.stringify(
      uploadableFiles.map((item) => ({
        clientFileName: item.file.name,
        statementType: item.statementType,
      })),
    ));

    try {
      const response = await apiClient.post<UploadResponse>(`/sessions/${sessionId}/files`, formData);
      const uploadedItems = response.uploaded.map((item) => ({
        ...item,
        statementType: toStatementType(item.statementType),
        autoDetectedType: toStatementType(item.autoDetectedType),
      }));

      setExistingFiles((current) => {
        const withoutDuplicates = current.filter(
          (existing) => !uploadedItems.some((uploaded) => uploaded.id === existing.id),
        );
        return [...uploadedItems, ...withoutDuplicates];
      });

      setUploadWarnings(response.warnings ?? []);
      setUploadRejected(response.rejected ?? []);
      setPendingFiles([]);
      const message = `Uploaded ${uploadedItems.length} file${uploadedItems.length === 1 ? '' : 's'}.`;
      setSuccessMessage(message);
      showToast(message, 'success');
    } catch {
      setErrorMessage('Upload failed. Please try again.');
      showToast('Upload failed. Please try again.', 'error');
    } finally {
      setIsUploading(false);
    }
  }

  function updateDraftType(fileId: string, statementType: StatementType) {
    setTypeDrafts((current) => ({ ...current, [fileId]: statementType }));
  }

  async function saveFileType(file: FileRecordItem) {
    if (!file.id) {
      return;
    }

    const nextType = typeDrafts[file.id] ?? file.statementType;
    setBusyFileId(file.id);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const result = await apiClient.patch<{ id: string; statementType: StatementType }>(
        `/files/${file.id}`,
        { statementType: nextType },
      );

      setExistingFiles((current) =>
        current.map((item) => (item.id === file.id ? { ...item, statementType: toStatementType(result.statementType) } : item)));
      setTypeDrafts((current) => {
        const copy = { ...current };
        delete copy[file.id];
        return copy;
      });
      const message = `Updated statement type for ${file.originalName}.`;
      setSuccessMessage(message);
      showToast(message, 'success');
    } catch {
      setErrorMessage('Could not update statement type.');
      showToast('Could not update statement type.', 'error');
    } finally {
      setBusyFileId(null);
    }
  }

  async function handleDeleteFile(file: FileRecordItem) {
    if (!file.id) {
      return;
    }

    const confirmed = window.confirm(`Delete file "${file.originalName}"?`);
    if (!confirmed) {
      return;
    }

    setBusyFileId(file.id);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await apiClient.delete<{ deleted: boolean }>(`/files/${file.id}`);
      setExistingFiles((current) => current.filter((item) => item.id !== file.id));
      const message = `Deleted ${file.originalName}.`;
      setSuccessMessage(message);
      showToast(message, 'success');
    } catch {
      setErrorMessage('Could not delete this file.');
      showToast('Could not delete this file.', 'error');
    } finally {
      setBusyFileId(null);
    }
  }

  function requestDeleteSession() {
    setShowDeleteSessionConfirm(true);
  }

  async function confirmDeleteSession() {
    if (!sessionId) {
      return;
    }

    setIsDeletingSession(true);
    setErrorMessage(null);
    try {
      await apiClient.delete<{ deleted: boolean }>(`/sessions/${sessionId}`);
      setShowDeleteSessionConfirm(false);
      showToast(`Session ${sessionId} deleted.`, 'success');
      navigate('/', { replace: true });
    } catch {
      setErrorMessage('Unable to delete this session right now.');
      showToast('Unable to delete this session right now.', 'error');
    } finally {
      setIsDeletingSession(false);
    }
  }

  return (
    <AppLayout>
      <h1>Session Dashboard</h1>
      <p className="muted page-lead">Upload, classify, and manage statements for this session.</p>

      <section className="card">
        <p>
          <strong>Session ID:</strong> {sessionId ?? '-'}
        </p>
      </section>

      {errorMessage && <p className="text-error" role="alert">{errorMessage}</p>}
      {successMessage && <p className="text-success" role="status">{successMessage}</p>}

      <div className="dashboard-main">
        <section className="card dashboard-panel dashboard-upload-panel" aria-busy={isUploading}>
          <h2>Upload Statements</h2>
          <p className="muted">Select up to {MAX_FILES_PER_UPLOAD} files. PDF files only.</p>

          <label className="field" htmlFor="dashboard-file-input">
            <span>Select files</span>
          </label>
          <input
            id="dashboard-file-input"
            className="input"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            onChange={onSelectFiles}
          />

          {pendingFiles.length > 0 && (
            <div className="stack-md dashboard-pending-list" role="list" aria-label="Files selected for upload">
              {pendingFiles.map((item) => (
                <article className="result-box dashboard-pending-item" key={item.localId} role="listitem">
                  <p><strong>{item.file.name}</strong></p>
                  <p className="muted">Size: {formatBytes(item.file.size)}</p>
                  {item.warning && <p className="text-error">{item.warning}</p>}

                  <label className="field">
                    <span>Statement Type</span>
                    <select
                      className="input"
                      value={item.statementType}
                      onChange={(event) => updatePendingType(item.localId, toStatementType(event.target.value))}
                    >
                      {STATEMENT_TYPE_OPTIONS.map((option) => (
                        <option value={option} key={option}>{option}</option>
                      ))}
                    </select>
                  </label>
                </article>
              ))}
            </div>
          )}

          <div className="actions dashboard-actions">
            <button
              className="button"
              type="button"
              onClick={handleUpload}
              disabled={isUploading || uploadableFiles.length === 0}
            >
              {isUploading ? 'Uploading...' : 'Upload'}
            </button>
          </div>

          {uploadWarnings.length > 0 && (
            <div className="stack-sm">
              <h3>Warnings</h3>
              {uploadWarnings.map((warning, index) => (
                <p className="text-warning" key={`${warning.originalName}-${index}`}>
                  {warning.originalName}: {warning.reason}
                </p>
              ))}
            </div>
          )}

          {uploadRejected.length > 0 && (
            <div className="stack-sm">
              <h3>Rejected</h3>
              {uploadRejected.map((item, index) => (
                <p className="text-error" key={`${item.originalName}-${index}`}>
                  {item.originalName}: {item.reason}
                </p>
              ))}
            </div>
          )}
        </section>

        <section className="card dashboard-panel dashboard-files-panel" aria-busy={isLoadingFiles}>
          <h2>Uploaded Files</h2>
          {isLoadingFiles && <p className="muted" role="status">Loading files...</p>}

          {!isLoadingFiles && existingFiles.length === 0 && (
            <p className="muted" role="status">No uploaded files yet.</p>
          )}

          {!isLoadingFiles && existingFiles.length > 0 && (
            <div className="stack-md dashboard-uploaded-list" role="list" aria-label="Uploaded files">
              {existingFiles.map((file) => {
                const draftValue = typeDrafts[file.id] ?? file.statementType;
                const saveDisabled = busyFileId === file.id || draftValue === file.statementType;

                return (
                  <article className="result-box dashboard-uploaded-item" key={file.id} role="listitem">
                    <div className="dashboard-uploaded-meta">
                      <p><strong>{file.originalName}</strong></p>
                      <p className="muted">Uploaded: {formatDate(file.uploadedAt)}</p>
                      <p className="muted">Size: {formatBytes(file.size)}</p>
                      <p className="muted">Statement Type: {file.statementType}</p>
                      <p className="muted">Auto-detected: {file.autoDetectedType ?? 'unknown'}</p>
                      {typeof file.detectionConfidence === 'number' && (
                        <p className="muted">
                          Confidence: {(file.detectionConfidence * 100).toFixed(0)}%
                        </p>
                      )}
                      {file.isLikelyStatement === false && (
                        <p className="text-warning">This file may not be a bank statement.</p>
                      )}
                    </div>

                    <div className="dashboard-uploaded-controls">
                      <label className="field dashboard-type-field">
                        <span>Override Type</span>
                        <select
                          className="input"
                          value={draftValue}
                          onChange={(event) => updateDraftType(file.id, toStatementType(event.target.value))}
                          disabled={busyFileId === file.id}
                        >
                          {STATEMENT_TYPE_OPTIONS.map((option) => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      </label>

                      <div className="actions dashboard-file-actions">
                        <button
                          className="button button-secondary"
                          type="button"
                          onClick={() => saveFileType(file)}
                          disabled={saveDisabled}
                        >
                          {busyFileId === file.id ? 'Saving...' : 'Save Type'}
                        </button>

                        <button
                          className="button button-secondary"
                          type="button"
                          onClick={() => handleDeleteFile(file)}
                          disabled={busyFileId === file.id}
                        >
                          {busyFileId === file.id ? 'Working...' : 'Delete File'}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Danger Zone</h2>
        <p className="muted">Delete this session and all associated uploaded files.</p>
        <button
          className="button danger-button"
          type="button"
          onClick={requestDeleteSession}
          disabled={isDeletingSession || !sessionId}
        >
          {isDeletingSession ? 'Deleting session...' : 'Delete Session'}
        </button>
      </section>

      <nav className="actions">
        <Link to="/sessions">Back to sessions</Link>
        <Link to="/">Back home</Link>
      </nav>

      <ConfirmDialog
        open={showDeleteSessionConfirm}
        title="Delete session?"
        message={
          sessionId
            ? `This will delete session ${sessionId} and all associated uploaded files.`
            : 'This will delete this session and all associated uploaded files.'
        }
        confirmLabel="Delete session"
        destructive
        busy={isDeletingSession}
        onCancel={() => setShowDeleteSessionConfirm(false)}
        onConfirm={confirmDeleteSession}
      />
    </AppLayout>
  );
}
