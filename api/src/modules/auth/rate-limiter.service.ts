import { Injectable } from '@nestjs/common';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 5;

@Injectable()
export class AuthRateLimiterService {
  private readonly hits = new Map<string, number[]>();

  isRateLimited(endpoint: string, ip: string | undefined, email: string): boolean {
    const now = Date.now();
    const key = `${endpoint}:${ip ?? 'unknown'}:${email}`;
    const recentHits = (this.hits.get(key) ?? []).filter((timestamp) => now - timestamp < WINDOW_MS);
    recentHits.push(now);
    this.hits.set(key, recentHits);
    return recentHits.length > MAX_REQUESTS;
  }
}
