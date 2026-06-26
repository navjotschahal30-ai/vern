import { ICRMAdapter, CRMAdapterConfig, LeadProfile } from './crmAdapter';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export abstract class BaseAdapter implements ICRMAdapter {
  protected config: CRMAdapterConfig;
  protected logLevel: LogLevel;
  protected dncList: Set<string> = new Set();

  constructor(config: CRMAdapterConfig) {
    this.config = config;
    this.logLevel = config.logLevel || 'info';
  }

  protected log(level: LogLevel, message: string, data?: any) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    if (levels[level] >= levels[this.logLevel]) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`, data || '');
    }
  }

  protected async handleError<T>(operation: string, fn: () => Promise<T>, retryCount = 0): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.message.includes('429') && retryCount < 3) {
        const backoff = 1000 * Math.pow(2, retryCount);
        this.log('warn', `Rate limited, retrying in ${backoff}ms`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        return this.handleError(operation, fn, retryCount + 1);
      }
      this.log('error', `${operation} failed`, { error: err.message });
      throw err;
    }
  }

  async isDNC(phoneOrEmail: string): Promise<boolean> {
    return this.dncList.has(this.normalizePhoneOrEmail(phoneOrEmail));
  }

  async recordDNC(phoneOrEmail: string, reason: string): Promise<void> {
    this.dncList.add(this.normalizePhoneOrEmail(phoneOrEmail));
    this.log('info', `Added to DNC: ${phoneOrEmail}`, { reason });
  }

  protected normalizePhoneOrEmail(input: string): string {
    return input.replace(/[^\w]/g, '').toLowerCase();
  }

  abstract authenticate(): Promise<void>;
  abstract getAssignedLeadIds(limit?: number, offset?: number): Promise<string[]>;
  abstract getLeadProfile(leadId: string): Promise<LeadProfile>;
  abstract tagLeadByQualification(leadId: string, qualStatus: 'hot' | 'warm' | 'ghost' | 'blocked'): Promise<void>;
  abstract recordOutreach(leadId: string, record: any): Promise<void>;
  abstract updateLeadState(leadId: string, stateKey: string, value: any): Promise<void>;
  abstract getLeadState(leadId: string, stateKey: string): Promise<string | null>;
  abstract healthCheck(): Promise<boolean>;
}
