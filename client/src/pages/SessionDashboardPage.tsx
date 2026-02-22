import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, apiClient, apiRequestBlob, getAccessToken } from '../api';
import { AppLayout } from '../ui/AppLayout';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast-provider';

type StatementType = 'credit' | 'checking' | 'savings' | 'unknown';
type FileCategory = StatementType | 'unfiled';

interface FileRecordItem {
  id: string;
  originalName: string;
  displayName?: string;
  statementType: StatementType;
  category?: FileCategory;
  autoDetectedType?: StatementType;
  detectionConfidence?: number;
  isLikelyStatement?: boolean;
  status?: string;
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

interface DetectFilePreviewItem {
  originalName: string;
  autoDetectedType: StatementType;
  detectionConfidence: number;
  isLikelyStatement: boolean;
}

interface DetectFilesResponse {
  files: DetectFilePreviewItem[];
}

interface SessionDetailsResponse {
  sessionId: string;
  autoCategorizeOnUpload?: boolean;
}

interface MoveFilesToCategoryResponse {
  movedCount: number;
  category: FileCategory;
}

interface UpdateFileResponse {
  id: string;
  originalName: string;
  displayName: string;
  statementType: StatementType;
  category: FileCategory;
}

interface PendingUploadFile {
  localId: string;
  file: File;
  statementType: StatementType;
  warning?: string;
  autoDetectedType?: StatementType;
  detectionConfidence?: number;
  isLikelyStatement?: boolean;
  detectionError?: string;
}

const MAX_FILES_PER_UPLOAD = 10;
const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_DISPLAY_NAME_LENGTH = 80;
const STATEMENT_TYPE_OPTIONS: StatementType[] = ['unknown', 'credit', 'checking', 'savings'];
const FOLDER_OPTIONS: StatementType[] = ['credit', 'checking', 'savings', 'unknown'];
const MOVE_TARGET_OPTIONS: FileCategory[] = ['unfiled', ...FOLDER_OPTIONS];
const AUTH_REQUIRED_MESSAGE = 'To access this session, continue via email link.';

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

function toFileCategory(value: unknown): FileCategory {
  if (value === 'credit' || value === 'checking' || value === 'savings' || value === 'unknown' || value === 'unfiled') {
    return value;
  }

  return 'unfiled';
}

function normalizeDisplayName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 ._()\-]/g, '-');
}

function getDisplayNameValidationError(value: string): string | null {
  if (value.length > MAX_DISPLAY_NAME_LENGTH) {
    return `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`;
  }

  const normalized = normalizeDisplayName(value);
  if (normalized.length === 0) {
    return 'Display name cannot be empty.';
  }

  return null;
}

function resolveDisplayName(file: Pick<FileRecordItem, 'displayName' | 'originalName'>): string {
  const preferred = file.displayName?.trim();
  if (preferred) {
    return preferred;
  }

  return file.originalName;
}

function getFileExtension(fileName: string): string {
  const trimmed = fileName.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0) {
    return '';
  }

  return trimmed.slice(lastDot);
}

function splitDisplayNameForEdit(displayName: string, lockedExtension: string): string {
  if (!lockedExtension) {
    return displayName;
  }

  if (displayName.toLowerCase().endsWith(lockedExtension.toLowerCase())) {
    return displayName.slice(0, -lockedExtension.length);
  }

  return displayName;
}

function getFileNameKey(fileName: string): string {
  return fileName.trim().toLowerCase();
}

function getPendingFileValidationWarning(file: File): string | undefined {
  const warnings: string[] = [];
  const normalizedFileName = normalizeDisplayName(file.name);
  if (normalizedFileName.length > MAX_DISPLAY_NAME_LENGTH) {
    warnings.push(`File name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`);
  }

  if (file.type !== 'application/pdf') {
    warnings.push('Only PDF files can be uploaded.');
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    warnings.push(`File exceeds max size (${MAX_FILE_SIZE_MB}MB).`);
  }

  if (warnings.length === 0) {
    return undefined;
  }

  return warnings.join(' ');
}

export function SessionDashboardPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const hasAccessToken = Boolean(getAccessToken());

  const [existingFiles, setExistingFiles] = useState<FileRecordItem[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingUploadFile[]>([]);
  const [typeDrafts, setTypeDrafts] = useState<Record<string, StatementType>>({});
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [editingNameFileId, setEditingNameFileId] = useState<string | null>(null);

  const [isLoadingFiles, setIsLoadingFiles] = useState(true);
  const [isDetectingPendingTypes, setIsDetectingPendingTypes] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [isDeletingAllFiles, setIsDeletingAllFiles] = useState(false);
  const [isDeletingSelectedFiles, setIsDeletingSelectedFiles] = useState(false);
  const [isUpdatingSessionSettings, setIsUpdatingSessionSettings] = useState(false);
  const [isMovingFilesToFolder, setIsMovingFilesToFolder] = useState(false);
  const [showDeleteSessionConfirm, setShowDeleteSessionConfirm] = useState(false);
  const [showDeleteAllFilesConfirm, setShowDeleteAllFilesConfirm] = useState(false);
  const [showDeleteSelectedFilesConfirm, setShowDeleteSelectedFilesConfirm] = useState(false);
  const [filePendingDelete, setFilePendingDelete] = useState<{ id: string; displayName: string } | null>(null);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [viewingFileId, setViewingFileId] = useState<string | null>(null);
  const [autoCategorizeOnUpload, setAutoCategorizeOnUpload] = useState(true);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [moveTargetFolder, setMoveTargetFolder] = useState<FileCategory>('checking');

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [uploadWarnings, setUploadWarnings] = useState<UploadWarningItem[]>([]);
  const [uploadRejected, setUploadRejected] = useState<UploadRejectedItem[]>([]);
  const [resolvingWarningKey, setResolvingWarningKey] = useState<string | null>(null);
  const isDeletingAnyFiles = isDeletingAllFiles || isDeletingSelectedFiles;

  useEffect(() => {
    if (!sessionId) {
      setErrorMessage('Missing session ID.');
      setIsLoadingFiles(false);
      return;
    }

    if (!hasAccessToken) {
      setErrorMessage(null);
      setIsLoadingFiles(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const loadFiles = async () => {
      setIsLoadingFiles(true);
      setErrorMessage(null);
      try {
        const [sessionDetails, response] = await Promise.all([
          apiClient.get<SessionDetailsResponse>(`/sessions/${sessionId}`, { signal: controller.signal }),
          apiClient.get<FileRecordItem[]>(
            `/sessions/${sessionId}/files`,
            { signal: controller.signal },
          ),
        ]);
        if (cancelled) {
          return;
        }

        setAutoCategorizeOnUpload(sessionDetails.autoCategorizeOnUpload !== false);
        const normalized = response.map((item) => ({
          ...item,
          displayName: resolveDisplayName(item),
          statementType: toStatementType(item.statementType),
          category: toFileCategory(item.category),
          autoDetectedType: toStatementType(item.autoDetectedType),
        }));

        setExistingFiles(normalized);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        if (error instanceof ApiError && error.status === 401) {
          setErrorMessage(AUTH_REQUIRED_MESSAGE);
          showToast(AUTH_REQUIRED_MESSAGE, 'error');
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
  }, [hasAccessToken, sessionId, showToast]);

  useEffect(() => {
    setSelectedFileIds((current) =>
      current.filter((id) => existingFiles.some((file) => file.id === id)),
    );
  }, [existingFiles]);

  const uploadableFiles = useMemo(
    () => pendingFiles.filter((item) => !item.warning),
    [pendingFiles],
  );
  const hasInvalidPendingFiles = useMemo(
    () => pendingFiles.some((item) => Boolean(item.warning)),
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
      warning: getPendingFileValidationWarning(file),
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

    if (!sessionId || !hasAccessToken) {
      return;
    }

    void detectPendingFileTypes(sessionId, nextPending);
  }

  function updatePendingType(localId: string, statementType: StatementType) {
    setPendingFiles((current) =>
      current.map((item) => (item.localId === localId ? { ...item, statementType } : item)));
  }

  async function detectPendingFileTypes(currentSessionId: string, pending: PendingUploadFile[]) {
    const pdfPending = pending.filter((item) => item.file.type === 'application/pdf' && !item.warning);
    if (pdfPending.length === 0) {
      return;
    }

    setIsDetectingPendingTypes(true);
    try {
      const formData = new FormData();
      pdfPending.forEach((item) => formData.append('files', item.file));

      const response = await apiClient.post<DetectFilesResponse>(
        `/sessions/${currentSessionId}/files/detect`,
        formData,
      );

      const previewByLocalId = new Map<string, DetectFilePreviewItem>();
      pdfPending.forEach((item, index) => {
        const preview = response.files?.[index];
        if (preview) {
          previewByLocalId.set(item.localId, preview);
        }
      });

      const targetIds = new Set(pending.map((item) => item.localId));
      setPendingFiles((current) =>
        current.map((item) => {
          if (!targetIds.has(item.localId)) {
            return item;
          }

          const preview = previewByLocalId.get(item.localId);
          if (!preview) {
            return {
              ...item,
              autoDetectedType: 'unknown',
              detectionConfidence: 0,
              isLikelyStatement: false,
              detectionError: item.file.type === 'application/pdf' ? 'Could not auto-detect this file.' : undefined,
            };
          }

          return {
            ...item,
            autoDetectedType: toStatementType(preview.autoDetectedType),
            detectionConfidence: Number.isFinite(preview.detectionConfidence) ? preview.detectionConfidence : 0,
            isLikelyStatement: Boolean(preview.isLikelyStatement),
            statementType:
              item.statementType === 'unknown' && preview.autoDetectedType !== 'unknown'
                ? toStatementType(preview.autoDetectedType)
                : item.statementType,
            detectionError: undefined,
          };
        }),
      );
    } catch {
      const targetIds = new Set(pending.map((item) => item.localId));
      setPendingFiles((current) =>
        current.map((item) => {
          if (!targetIds.has(item.localId) || item.file.type !== 'application/pdf') {
            return item;
          }

          return {
            ...item,
            autoDetectedType: 'unknown',
            detectionConfidence: 0,
            isLikelyStatement: false,
            detectionError: 'Could not auto-detect this file.',
          };
        }),
      );
      showToast('Could not auto-detect file types before upload.', 'error');
    } finally {
      setIsDetectingPendingTypes(false);
    }
  }

  async function handleUpload() {
    if (!sessionId) {
      setErrorMessage('Missing session ID.');
      return;
    }

    if (!hasAccessToken) {
      setErrorMessage(AUTH_REQUIRED_MESSAGE);
      return;
    }

    if (hasInvalidPendingFiles) {
      setErrorMessage('Remove files with errors before uploading.');
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
        displayName: resolveDisplayName(item),
        statementType: toStatementType(item.statementType),
        category: toFileCategory(item.category),
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
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setErrorMessage(AUTH_REQUIRED_MESSAGE);
        showToast(AUTH_REQUIRED_MESSAGE, 'error');
      } else {
        setErrorMessage('Upload failed. Please try again.');
        showToast('Upload failed. Please try again.', 'error');
      }
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
    if (isDeletingAnyFiles) {
      return;
    }

    const nextType = typeDrafts[file.id] ?? file.statementType;
    setBusyFileId(file.id);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const result = await apiClient.patch<UpdateFileResponse>(
        `/files/${file.id}`,
        { statementType: nextType },
      );

      setExistingFiles((current) =>
        current.map((item) => {
          if (item.id !== file.id) {
            return item;
          }

          const nextType = toStatementType(result.statementType);
          return {
            ...item,
            originalName: result.originalName,
            displayName: resolveDisplayName(result),
            statementType: nextType,
            category: toFileCategory(result.category),
          };
        }));
      setTypeDrafts((current) => {
        const copy = { ...current };
        delete copy[file.id];
        return copy;
      });
      const message = `Updated statement type for ${resolveDisplayName(file)}.`;
      setSuccessMessage(message);
      showToast(message, 'success');
    } catch {
      setErrorMessage('Could not update statement type.');
      showToast('Could not update statement type.', 'error');
    } finally {
      setBusyFileId(null);
    }
  }

  function startEditingFileName(file: FileRecordItem) {
    if (!file.id || isDeletingAnyFiles || isMovingFilesToFolder) {
      return;
    }

    const displayName = resolveDisplayName(file);
    const lockedExtension = getFileExtension(file.originalName);
    const editableBaseName = splitDisplayNameForEdit(displayName, lockedExtension);
    setNameDrafts((current) => ({
      ...current,
      [file.id]: current[file.id] ?? editableBaseName,
    }));
    setEditingNameFileId(file.id);
  }

  function updateNameDraft(fileId: string, baseName: string) {
    setNameDrafts((current) => ({ ...current, [fileId]: baseName }));
  }

  function stopEditingFileName(fileId: string) {
    setEditingNameFileId((current) => (current === fileId ? null : current));
    setNameDrafts((current) => {
      const next = { ...current };
      delete next[fileId];
      return next;
    });
  }

  async function saveFileName(file: FileRecordItem) {
    if (!file.id || isDeletingAnyFiles || isMovingFilesToFolder) {
      return;
    }

    const lockedExtension = getFileExtension(file.originalName);
    const currentDisplayName = resolveDisplayName(file);
    const currentDisplayBase = splitDisplayNameForEdit(currentDisplayName, lockedExtension);
    const nextDisplayNameDraft = nameDrafts[file.id] ?? currentDisplayBase;
    if (nextDisplayNameDraft.trim().length === 0) {
      return;
    }
    const nextDisplayName = normalizeDisplayName(`${nextDisplayNameDraft.trim()}${lockedExtension}`);
    const validationError = getDisplayNameValidationError(nextDisplayName);
    if (validationError) {
      return;
    }
    if (nextDisplayName === currentDisplayName) {
      stopEditingFileName(file.id);
      return;
    }

    setBusyFileId(file.id);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const result = await apiClient.patch<UpdateFileResponse>(
        `/files/${file.id}`,
        { displayName: nextDisplayName },
      );

      setExistingFiles((current) =>
        current.map((item) => {
          if (item.id !== file.id) {
            return item;
          }

          return {
            ...item,
            originalName: result.originalName,
            displayName: resolveDisplayName(result),
            statementType: toStatementType(result.statementType),
            category: toFileCategory(result.category),
          };
        }));
      stopEditingFileName(file.id);
      const message = `Updated display name to ${resolveDisplayName(result)}.`;
      setSuccessMessage(message);
      showToast(message, 'success');
    } catch {
      setErrorMessage('Could not update this display name.');
      showToast('Could not update this display name.', 'error');
    } finally {
      setBusyFileId(null);
    }
  }

  function handleFileNameInputKeyDown(event: KeyboardEvent<HTMLInputElement>, file: FileRecordItem) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveFileName(file);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      stopEditingFileName(file.id);
    }
  }

  function removePendingFile(localId: string) {
    setPendingFiles((current) => current.filter((item) => item.localId !== localId));
  }

  function dismissUploadWarning(index: number) {
    setUploadWarnings((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  function findDuplicateFileForWarning(warning: UploadWarningItem): FileRecordItem | null {
    const warningFileNameKey = getFileNameKey(warning.originalName);
    const candidates = existingFiles.filter((file) => {
      if (!file.id) {
        return false;
      }
      if (getFileNameKey(file.originalName) !== warningFileNameKey) {
        return false;
      }
      return getFileNameKey(resolveDisplayName(file)) === warningFileNameKey;
    });

    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    const sortedByMostRecentUpload = [...candidates].sort((left, right) => {
      const leftDate = left.uploadedAt ? Date.parse(left.uploadedAt) : 0;
      const rightDate = right.uploadedAt ? Date.parse(right.uploadedAt) : 0;
      return rightDate - leftDate;
    });

    return sortedByMostRecentUpload[0] ?? null;
  }

  async function handleDeleteDuplicateFromWarning(warning: UploadWarningItem, index: number) {
    const duplicateFile = findDuplicateFileForWarning(warning);
    if (!duplicateFile?.id) {
      const message = 'Could not find the duplicate file to delete.';
      setErrorMessage(message);
      showToast(message, 'error');
      return;
    }

    const warningKey = `${warning.originalName}-${index}`;
    setResolvingWarningKey(warningKey);
    setBusyFileId(duplicateFile.id);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      await apiClient.delete<{ deleted: boolean }>(`/files/${duplicateFile.id}`);
      setExistingFiles((current) => current.filter((item) => item.id !== duplicateFile.id));
      setTypeDrafts((current) => {
        const next = { ...current };
        delete next[duplicateFile.id];
        return next;
      });
      setNameDrafts((current) => {
        const next = { ...current };
        delete next[duplicateFile.id];
        return next;
      });
      setSelectedFileIds((current) => current.filter((id) => id !== duplicateFile.id));
      stopEditingFileName(duplicateFile.id);
      dismissUploadWarning(index);

      const message = `Deleted duplicate file "${warning.originalName}".`;
      setSuccessMessage(message);
      showToast(message, 'success');
    } catch {
      const message = 'Could not delete the duplicate file.';
      setErrorMessage(message);
      showToast(message, 'error');
    } finally {
      setBusyFileId((current) => (current === duplicateFile.id ? null : current));
      setResolvingWarningKey((current) => (current === warningKey ? null : current));
    }
  }

  function requestDeleteFile(file: FileRecordItem) {
    if (!file.id) {
      return;
    }
    if (isDeletingAnyFiles) {
      return;
    }

    setFilePendingDelete({
      id: file.id,
      displayName: resolveDisplayName(file),
    });
  }

  async function confirmDeleteFile() {
    const targetFile = filePendingDelete;
    if (!targetFile) {
      return;
    }

    setBusyFileId(targetFile.id);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await apiClient.delete<{ deleted: boolean }>(`/files/${targetFile.id}`);
      removeFilesFromLocalState([targetFile.id]);
      const message = `Deleted ${targetFile.displayName}.`;
      showToast(message, 'success');
      setFilePendingDelete(null);
    } catch {
      setErrorMessage('Could not delete this file.');
      showToast('Could not delete this file.', 'error');
    } finally {
      setBusyFileId(null);
    }
  }

  async function handleViewFile(file: FileRecordItem) {
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
      setErrorMessage('Could not open this file.');
      showToast('Could not open this file.', 'error');
    } finally {
      setViewingFileId(null);
    }
  }

  async function handleToggleAutoCategorize(nextValue: boolean) {
    if (!sessionId) {
      return;
    }

    const previous = autoCategorizeOnUpload;
    setAutoCategorizeOnUpload(nextValue);
    setIsUpdatingSessionSettings(true);
    try {
      const response = await apiClient.patch<{ autoCategorizeOnUpload: boolean }>(
        `/sessions/${sessionId}/settings`,
        { autoCategorizeOnUpload: nextValue },
      );
      setAutoCategorizeOnUpload(response.autoCategorizeOnUpload !== false);
      showToast(
        response.autoCategorizeOnUpload !== false
          ? 'Auto-categorize is on for new uploads.'
          : 'Auto-categorize is off. New uploads will go to root.',
        'success',
      );
    } catch {
      setAutoCategorizeOnUpload(previous);
      showToast('Could not update auto-categorize setting.', 'error');
    } finally {
      setIsUpdatingSessionSettings(false);
    }
  }

  function toggleFileSelection(fileId: string, checked: boolean) {
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

  async function moveSelectedFiles() {
    if (!sessionId || selectedFileIds.length === 0) {
      return;
    }

    setIsMovingFilesToFolder(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.patch<MoveFilesToCategoryResponse>(
        `/sessions/${sessionId}/files/category`,
        { fileIds: selectedFileIds, category: moveTargetFolder },
      );

      const movedSet = new Set(selectedFileIds);
      setExistingFiles((current) =>
        current.map((file) => {
          if (!movedSet.has(file.id)) {
            return file;
          }

          const nextCategory = toFileCategory(response.category);
          const nextStatementType = nextCategory === 'unfiled'
            ? file.statementType
            : toStatementType(nextCategory);
          return {
            ...file,
            category: nextCategory,
            statementType: nextStatementType,
          };
        }),
      );
      setTypeDrafts((current) => {
        const next = { ...current };
        selectedFileIds.forEach((id) => {
          delete next[id];
        });
        return next;
      });

      setSelectedFileIds([]);
      const folderLabel = moveTargetFolder === 'unfiled' ? 'root' : moveTargetFolder;
      showToast(
        `Moved ${response.movedCount} file${response.movedCount === 1 ? '' : 's'} to ${folderLabel}.`,
        'success',
      );
    } catch {
      setErrorMessage('Could not move selected files right now.');
      showToast('Could not move selected files right now.', 'error');
    } finally {
      setIsMovingFilesToFolder(false);
    }
  }

  function removeFilesFromLocalState(deletedIds: string[]) {
    if (deletedIds.length === 0) {
      return;
    }

    const deletedIdSet = new Set(deletedIds);
    setExistingFiles((current) => current.filter((file) => !deletedIdSet.has(file.id)));
    setTypeDrafts((current) => {
      const next = { ...current };
      deletedIds.forEach((id) => {
        delete next[id];
      });
      return next;
    });
    setNameDrafts((current) => {
      const next = { ...current };
      deletedIds.forEach((id) => {
        delete next[id];
      });
      return next;
    });
    setSelectedFileIds((current) => current.filter((id) => !deletedIdSet.has(id)));
    setEditingNameFileId((current) => (current && deletedIdSet.has(current) ? null : current));
  }

  function requestDeleteSession() {
    setShowDeleteSessionConfirm(true);
  }

  function requestDeleteSelectedFiles() {
    if (selectedFileIds.length === 0) {
      showToast('Select at least one uploaded file to delete.', 'info');
      return;
    }

    setShowDeleteSelectedFilesConfirm(true);
  }

  async function confirmDeleteSelectedFiles() {
    const selectedIdSet = new Set(selectedFileIds);
    const targetFiles = existingFiles.filter((file) => file.id && selectedIdSet.has(file.id));
    if (targetFiles.length === 0) {
      setShowDeleteSelectedFilesConfirm(false);
      showToast('No selected uploaded files to delete.', 'info');
      return;
    }

    setIsDeletingSelectedFiles(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    const results = await Promise.allSettled(
      targetFiles.map((file) => apiClient.delete<{ deleted: boolean }>(`/files/${file.id}`)),
    );

    const deletedIds: string[] = [];
    let failedCount = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const id = targetFiles[index]?.id;
        if (id) {
          deletedIds.push(id);
        }
      } else {
        failedCount += 1;
      }
    });

    removeFilesFromLocalState(deletedIds);

    if (failedCount === 0) {
      const message = `Deleted ${deletedIds.length} selected file${deletedIds.length === 1 ? '' : 's'}.`;
      setSuccessMessage(message);
      showToast(message, 'success');
    } else if (deletedIds.length === 0) {
      const message = 'Unable to delete selected files right now.';
      setErrorMessage(message);
      showToast(message, 'error');
    } else {
      const message = `Deleted ${deletedIds.length} selected file${deletedIds.length === 1 ? '' : 's'}. ${failedCount} failed.`;
      setErrorMessage(message);
      showToast(message, 'error');
    }

    setShowDeleteSelectedFilesConfirm(false);
    setIsDeletingSelectedFiles(false);
  }

  function requestDeleteAllFiles() {
    if (existingFiles.length === 0) {
      showToast('No uploaded files to delete.', 'info');
      return;
    }

    setShowDeleteAllFilesConfirm(true);
  }

  async function confirmDeleteAllFiles() {
    if (existingFiles.length === 0) {
      setShowDeleteAllFilesConfirm(false);
      showToast('No uploaded files to delete.', 'info');
      return;
    }

    const targetFiles = existingFiles.filter((file) => Boolean(file.id));
    if (targetFiles.length === 0) {
      setShowDeleteAllFilesConfirm(false);
      showToast('No uploaded files to delete.', 'info');
      return;
    }

    setIsDeletingAllFiles(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    const results = await Promise.allSettled(
      targetFiles.map((file) => apiClient.delete<{ deleted: boolean }>(`/files/${file.id}`)),
    );

    const deletedIds: string[] = [];
    let failedCount = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const id = targetFiles[index]?.id;
        if (id) {
          deletedIds.push(id);
        }
      } else {
        failedCount += 1;
      }
    });

    removeFilesFromLocalState(deletedIds);

    if (failedCount === 0) {
      const message = `Deleted ${deletedIds.length} file${deletedIds.length === 1 ? '' : 's'}.`;
      setSuccessMessage(message);
      showToast(message, 'success');
    } else if (deletedIds.length === 0) {
      const message = 'Unable to delete uploaded files right now.';
      setErrorMessage(message);
      showToast(message, 'error');
    } else {
      const message = `Deleted ${deletedIds.length} file${deletedIds.length === 1 ? '' : 's'}. ${failedCount} failed.`;
      setErrorMessage(message);
      showToast(message, 'error');
    }

    setShowDeleteAllFilesConfirm(false);
    setIsDeletingAllFiles(false);
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

  function renderUploadedFileCard(file: FileRecordItem) {
    const draftValue = typeDrafts[file.id] ?? file.statementType;
    const currentDisplayName = resolveDisplayName(file);
    const lockedExtension = getFileExtension(file.originalName);
    const currentDisplayBase = splitDisplayNameForEdit(currentDisplayName, lockedExtension);
    const nameDraftValue = nameDrafts[file.id] ?? currentDisplayBase;
    const composedDisplayName = `${nameDraftValue.trim()}${lockedExtension}`;
    const normalizedComposedDisplayName = normalizeDisplayName(composedDisplayName);
    const displayNameValidationError = nameDraftValue.trim().length === 0
      ? 'Display name cannot be empty.'
      : getDisplayNameValidationError(composedDisplayName);
    const isEditingName = editingNameFileId === file.id;
    const renameDisabled = busyFileId === file.id
      || viewingFileId === file.id
      || isDeletingAnyFiles
      || isMovingFilesToFolder;
    const renameSaveDisabled = renameDisabled
      || Boolean(displayNameValidationError)
      || normalizedComposedDisplayName === currentDisplayName;
    const saveDisabled = busyFileId === file.id
      || viewingFileId === file.id
      || draftValue === file.statementType;
    const statusLabel = file.status ? file.status : 'uploaded';
    const autoDetectedSummary = typeof file.detectionConfidence === 'number'
      ? `${file.autoDetectedType ?? 'unknown'} (${(file.detectionConfidence * 100).toFixed(0)}%)`
      : (file.autoDetectedType ?? 'unknown');
    const isSelectedForMove = selectedFileIds.includes(file.id);

    return (
      <article className="result-box dashboard-uploaded-item minw0" key={file.id} role="listitem">
        <div className={`dashboard-uploaded-top minw0${isEditingName ? ' dashboard-uploaded-top-editing' : ''}`}>
          <p className="dashboard-file-name minw0">
            <label className="session-select-inline">
              <input
                className="session-select-input"
                type="checkbox"
                checked={isSelectedForMove}
                onChange={(event) => toggleFileSelection(file.id, event.target.checked)}
                disabled={isMovingFilesToFolder || isDeletingAnyFiles}
                aria-label={`Select ${currentDisplayName} for bulk actions`}
              />
            </label>
            {!isEditingName && (
              <span className="dashboard-file-name-readonly minw0">
                <strong title={currentDisplayName}>{currentDisplayName}</strong>
                <button
                  className="dashboard-rename-icon-button"
                  type="button"
                  onClick={() => startEditingFileName(file)}
                  disabled={renameDisabled}
                  aria-label={`Edit display name for ${currentDisplayName}`}
                  title="Edit display name"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path
                      d="M16.862 3.487a2.25 2.25 0 0 1 3.182 3.182L8.32 18.393l-4.004.821.822-4.004L16.862 3.487zm0 0 3.182 3.182"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </span>
            )}
            {isEditingName && (
              <span className="dashboard-file-name-editor minw0">
                <span className="dashboard-file-name-input-row">
                  <input
                    className="input dashboard-file-name-input"
                    value={nameDraftValue}
                    onChange={(event) => updateNameDraft(file.id, event.target.value)}
                    onKeyDown={(event) => handleFileNameInputKeyDown(event, file)}
                    disabled={renameDisabled}
                    aria-label={`Edit display name for ${currentDisplayName}`}
                  />
                  {lockedExtension && <span className="dashboard-file-extension-pill">{lockedExtension}</span>}
                </span>
                <small className={displayNameValidationError ? 'text-error dashboard-name-counter' : 'muted dashboard-name-counter'}>
                  {`${nameDraftValue.length + lockedExtension.length} / ${MAX_DISPLAY_NAME_LENGTH}`}
                </small>
                {displayNameValidationError && <p className="text-error dashboard-name-error">{displayNameValidationError}</p>}
                <span className="dashboard-file-name-editor-actions">
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={() => void saveFileName(file)}
                    disabled={renameSaveDisabled}
                  >
                    {busyFileId === file.id ? 'Saving...' : 'Save Name'}
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={() => stopEditingFileName(file.id)}
                    disabled={renameDisabled}
                  >
                    Cancel
                  </button>
                </span>
              </span>
            )}
          </p>
          <span className="dashboard-status-badge">
            {statusLabel}
          </span>
        </div>

        <dl className="dashboard-uploaded-meta-grid minw0">
          <div className="dashboard-meta-item minw0">
            <dt>Uploaded</dt>
            <dd className="break">{formatDate(file.uploadedAt)}</dd>
          </div>
          <div className="dashboard-meta-item minw0">
            <dt>Size</dt>
            <dd className="break">{formatBytes(file.size)}</dd>
          </div>
          <div className="dashboard-meta-item minw0">
            <dt>Statement Type</dt>
            <dd className="break">{file.statementType}</dd>
          </div>
          <div className="dashboard-meta-item minw0">
            <dt>Auto-detected</dt>
            <dd className="break">{autoDetectedSummary}</dd>
          </div>
        </dl>

        {file.isLikelyStatement === false && (
          <p className="text-warning">This file may not be a bank statement.</p>
        )}

        <div className="dashboard-uploaded-controls controls minw0">
          <label className="field dashboard-type-field">
            <span>Override Type</span>
            <select
              className="input"
              value={draftValue}
              onChange={(event) => updateDraftType(file.id, toStatementType(event.target.value))}
              disabled={busyFileId === file.id || isDeletingAnyFiles || isMovingFilesToFolder}
            >
              {STATEMENT_TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>

          <div className="dashboard-file-actions controls minw0">
            <button
              className="button button-secondary"
              type="button"
              onClick={() => handleViewFile(file)}
              disabled={busyFileId === file.id || viewingFileId === file.id || isDeletingAnyFiles || isMovingFilesToFolder}
            >
              {viewingFileId === file.id ? 'Opening...' : 'View File'}
            </button>

            <button
              className="button button-secondary"
              type="button"
              onClick={() => saveFileType(file)}
              disabled={saveDisabled || isDeletingAnyFiles || isMovingFilesToFolder}
            >
              {busyFileId === file.id ? 'Saving...' : 'Save Type'}
            </button>

            <button
              className="button button-secondary"
              type="button"
              onClick={() => requestDeleteFile(file)}
              disabled={busyFileId === file.id || isDeletingAnyFiles || isMovingFilesToFolder}
            >
              {busyFileId === file.id ? 'Working...' : 'Delete File'}
            </button>
          </div>
        </div>
      </article>
    );
  }

  const fileCountLabel = `${existingFiles.length} file${existingFiles.length === 1 ? '' : 's'} in this session`;
  const filesByCategory = useMemo(() => {
    const grouped: Record<FileCategory, FileRecordItem[]> = {
      unfiled: [],
      credit: [],
      checking: [],
      savings: [],
      unknown: [],
    };

    existingFiles.forEach((file) => {
      const category = toFileCategory(file.category);
      grouped[category].push(file);
    });

    return grouped;
  }, [existingFiles]);
  const unfiledFiles = filesByCategory.unfiled;
  const folderCounts = {
    credit: filesByCategory.credit.length,
    checking: filesByCategory.checking.length,
    savings: filesByCategory.savings.length,
    unknown: filesByCategory.unknown.length,
  };
  const selectedUploadedFiles = useMemo(() => {
    if (selectedFileIds.length === 0) {
      return [];
    }
    const selectedIdSet = new Set(selectedFileIds);
    return existingFiles.filter((file) => selectedIdSet.has(file.id));
  }, [existingFiles, selectedFileIds]);
  const selectedFileCount = selectedUploadedFiles.length;
  const managementActionsDisabled = isLoadingFiles
    || isDeletingAnyFiles
    || isDeletingSession
    || isMovingFilesToFolder
    || isUpdatingSessionSettings;

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

      {!hasAccessToken && (
        <>
          <section className="card">
            <p className="muted">{AUTH_REQUIRED_MESSAGE}</p>
            <div className="actions">
              <Link className="button" to="/#continue-session">Continue Session</Link>
            </div>
          </section>
          <nav className="actions">
            <Link to="/">Back home</Link>
          </nav>
        </>
      )}

      {hasAccessToken && (
        <>
          <section
            className="card dashboard-manage-panel"
            aria-busy={isDeletingAnyFiles || isDeletingSession || isUpdatingSessionSettings || isMovingFilesToFolder}
          >
            <div className="dashboard-manage-header">
              <div>
                <h2>Manage Session</h2>
                <p className="muted">Session-level cleanup and destructive actions.</p>
              </div>
              <p className="muted dashboard-manage-count">{isLoadingFiles ? 'Loading file count...' : fileCountLabel}</p>
            </div>
            <label className="dashboard-manage-toggle">
              <input
                type="checkbox"
                checked={autoCategorizeOnUpload}
                onChange={(event) => void handleToggleAutoCategorize(event.target.checked)}
                disabled={isUpdatingSessionSettings || isLoadingFiles}
              />
              <span>
                Auto-categorize on upload
                <small className="muted">
                  {autoCategorizeOnUpload
                    ? 'New uploads go directly into credit/checking/savings/unknown folders.'
                    : 'New uploads stay in root (unfiled) until moved.'}
                </small>
              </span>
            </label>
            <div className="dashboard-folder-counts">
              <span className="dashboard-folder-pill">credit: {folderCounts.credit}</span>
              <span className="dashboard-folder-pill">checking: {folderCounts.checking}</span>
              <span className="dashboard-folder-pill">savings: {folderCounts.savings}</span>
              <span className="dashboard-folder-pill">unknown: {folderCounts.unknown}</span>
              <span className="dashboard-folder-pill">root: {unfiledFiles.length}</span>
            </div>
            <div className="dashboard-manage-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={requestDeleteAllFiles}
                disabled={managementActionsDisabled || existingFiles.length === 0}
              >
                {isDeletingAnyFiles ? 'Deleting files...' : 'Delete All Files'}
              </button>
              <button
                className="button danger-button"
                type="button"
                onClick={requestDeleteSession}
                disabled={managementActionsDisabled || !sessionId}
              >
                {isDeletingSession ? 'Deleting session...' : 'Delete Session'}
              </button>
            </div>
          </section>

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

              {pendingFiles.length > 0 && isDetectingPendingTypes && (
                <p className="muted" role="status">Detecting statement types...</p>
              )}

              {pendingFiles.length > 0 && (
                <div className="stack-md dashboard-pending-list" role="list" aria-label="Files selected for upload">
                  {pendingFiles.map((item) => (
                    <article className="result-box dashboard-pending-item" key={item.localId} role="listitem">
                      <p><strong>{item.file.name}</strong></p>
                      <p className="muted">Size: {formatBytes(item.file.size)}</p>
                      {item.warning && <p className="text-error">{item.warning}</p>}
                      <p className="muted">
                        Auto-detected:{' '}
                        {item.autoDetectedType
                          ? `${item.autoDetectedType}${typeof item.detectionConfidence === 'number'
                            ? ` (${(item.detectionConfidence * 100).toFixed(0)}%)`
                            : ''}`
                          : 'pending'}
                      </p>
                      {item.detectionError && <p className="text-warning">{item.detectionError}</p>}
                      {item.isLikelyStatement === false && !item.detectionError && item.autoDetectedType === 'unknown' && (
                        <p className="text-warning">This may not be a bank statement.</p>
                      )}

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

                      <div className="actions dashboard-pending-actions">
                        <button
                          className="button button-secondary"
                          type="button"
                          onClick={() => removePendingFile(item.localId)}
                          disabled={isUploading}
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              <div className="actions dashboard-actions">
                <button
                  className="button"
                  type="button"
                  onClick={handleUpload}
                  disabled={
                    isUploading
                    || isDeletingAnyFiles
                    || isDeletingSession
                    || isMovingFilesToFolder
                    || hasInvalidPendingFiles
                    || uploadableFiles.length === 0
                  }
                >
                  {isUploading ? 'Uploading...' : 'Upload'}
                </button>
              </div>

              {uploadWarnings.length > 0 && (
                <div className="stack-sm">
                  <h3>Warnings</h3>
                  {uploadWarnings.map((warning, index) => (
                    (() => {
                      const warningKey = `${warning.originalName}-${index}`;
                      const duplicateFile = findDuplicateFileForWarning(warning);
                      const actionDisabled = resolvingWarningKey !== null
                        || isDeletingAnyFiles
                        || isUploading
                        || isMovingFilesToFolder;

                      return (
                        <article className="dashboard-warning-item" key={warningKey}>
                          <p className="text-warning">
                            {warning.originalName}: {warning.reason}
                          </p>
                          <p className="muted">Delete duplicate or keep both files.</p>
                          <div className="dashboard-warning-actions">
                            <button
                              className="button button-secondary"
                              type="button"
                              onClick={() => void handleDeleteDuplicateFromWarning(warning, index)}
                              disabled={actionDisabled || !duplicateFile?.id}
                            >
                              {resolvingWarningKey === warningKey ? 'Deleting...' : 'Delete duplicate'}
                            </button>
                            <button
                              className="button button-secondary"
                              type="button"
                              onClick={() => dismissUploadWarning(index)}
                              disabled={actionDisabled}
                            >
                              Keep both files
                            </button>
                          </div>
                        </article>
                      );
                    })()
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
              <div className="dashboard-file-move-controls">
                <label className="field">
                  <span>Move or delete selected files</span>
                  <select
                    className="input"
                    value={moveTargetFolder}
                    onChange={(event) => setMoveTargetFolder(toFileCategory(event.target.value))}
                    disabled={isMovingFilesToFolder || isLoadingFiles}
                  >
                    {MOVE_TARGET_OPTIONS.map((option) => (
                      <option value={option} key={option}>
                        {option === 'unfiled' ? 'root' : option}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={moveSelectedFiles}
                  disabled={isMovingFilesToFolder || isDeletingAnyFiles || selectedFileCount === 0}
                >
                  {isMovingFilesToFolder ? 'Moving...' : `Move Selected (${selectedFileCount})`}
                </button>
                <button
                  className="button danger-button"
                  type="button"
                  onClick={requestDeleteSelectedFiles}
                  disabled={isMovingFilesToFolder || isDeletingAnyFiles || selectedFileCount === 0}
                >
                  {isDeletingSelectedFiles ? 'Deleting selected...' : `Delete Selected (${selectedFileCount})`}
                </button>
              </div>
              {isLoadingFiles && <p className="muted" role="status">Loading files...</p>}

              {!isLoadingFiles && existingFiles.length === 0 && (
                <p className="muted" role="status">No uploaded files yet.</p>
              )}

              {!isLoadingFiles && existingFiles.length > 0 && (
                <div className="stack-md dashboard-uploaded-list" role="list" aria-label="Uploaded files">
                  <section className="result-box dashboard-folder-section">
                    <div className="dashboard-folder-header">
                      <h3>Root (Unfiled)</h3>
                      <span className="dashboard-status-badge">{unfiledFiles.length}</span>
                    </div>
                    {unfiledFiles.length === 0 ? (
                      <p className="muted">No root files.</p>
                    ) : (
                      <div className="stack-md">
                        {unfiledFiles.map((file) => renderUploadedFileCard(file))}
                      </div>
                    )}
                  </section>

                  {FOLDER_OPTIONS.map((category) => (
                    <section className="result-box dashboard-folder-section" key={category}>
                      <div className="dashboard-folder-header">
                        <h3>{category[0].toUpperCase() + category.slice(1)} Folder</h3>
                        <span className="dashboard-status-badge">{filesByCategory[category].length}</span>
                      </div>
                      {filesByCategory[category].length === 0 ? (
                        <p className="muted">No files in this folder.</p>
                      ) : (
                        <div className="stack-md">
                          {filesByCategory[category].map((file) => renderUploadedFileCard(file))}
                        </div>
                      )}
                    </section>
                  ))}
                </div>
              )}
            </section>
          </div>

          <nav className="actions">
            <Link to="/sessions">Back to sessions</Link>
            <Link to="/">Back home</Link>
          </nav>
        </>
      )}

      <ConfirmDialog
        open={Boolean(filePendingDelete)}
        title="Delete file?"
        message={
          filePendingDelete
            ? `Delete "${filePendingDelete.displayName}"?`
            : 'Delete this file?'
        }
        confirmLabel="Delete file"
        destructive
        busy={Boolean(filePendingDelete && busyFileId === filePendingDelete.id)}
        onCancel={() => setFilePendingDelete(null)}
        onConfirm={confirmDeleteFile}
      />

      <ConfirmDialog
        open={showDeleteSelectedFilesConfirm}
        title="Delete selected files?"
        message={
          selectedFileCount === 1
            ? 'This will permanently delete the selected uploaded file.'
            : `This will permanently delete ${selectedFileCount} selected uploaded files.`
        }
        confirmLabel="Delete selected files"
        destructive
        busy={isDeletingSelectedFiles}
        onCancel={() => setShowDeleteSelectedFilesConfirm(false)}
        onConfirm={confirmDeleteSelectedFiles}
      />

      <ConfirmDialog
        open={showDeleteAllFilesConfirm}
        title="Delete all files?"
        message={
          existingFiles.length === 1
            ? 'This will permanently delete the only uploaded file in this session.'
            : `This will permanently delete ${existingFiles.length} uploaded files in this session.`
        }
        confirmLabel="Delete all files"
        destructive
        busy={isDeletingAllFiles}
        onCancel={() => setShowDeleteAllFilesConfirm(false)}
        onConfirm={confirmDeleteAllFiles}
      />

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
