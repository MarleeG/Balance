import { getAccessToken } from './token-storage';

const DEFAULT_API_BASE_URL = 'http://localhost:3000';

function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  const baseUrl = configured && configured.length > 0 ? configured : DEFAULT_API_BASE_URL;
  return baseUrl.replace(/\/+$/, '');
}

function buildUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalizedPath}`;
}

function isJsonContentType(contentType: string | null): boolean {
  return Boolean(contentType && contentType.toLowerCase().includes('application/json'));
}

export class ApiError extends Error {
  status: number;
  statusText: string;
  payload: unknown;

  constructor(status: number, statusText: string, payload: unknown) {
    super(`API request failed (${status} ${statusText}).`);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.payload = payload;
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'method' | 'headers' | 'body'> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: FormData | unknown;
  skipAuth?: boolean;
  accessToken?: string | null;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  if (isJsonContentType(response.headers.get('content-type'))) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  try {
    return await response.text();
  } catch {
    return null;
  }
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };

  const token = options.skipAuth ? null : (options.accessToken ?? getAccessToken());
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof FormData) {
      body = options.body;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
  }

  const response = await fetch(buildUrl(path), {
    ...options,
    method,
    headers,
    body,
  });

  const payload = await parseResponseBody(response);
  if (!response.ok) {
    throw new ApiError(response.status, response.statusText, payload);
  }

  return payload as T;
}

export const apiClient = {
  get: <T>(path: string, options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: ApiRequestOptions['body'], options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: ApiRequestOptions['body'], options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: ApiRequestOptions['body'], options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};
