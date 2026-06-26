export interface LeadProfile {
  leadId: string;
  name: string;
  email?: string;
  phone?: string;
  createdDate: Date;
  lastContactDate?: Date;
  tags: string[];
  customFields?: Record<string, any>;
}

export interface CRMAdapterConfig {
  apiKey: string;
  agentName: string;
  agentPhone: string;
  agentWebsite: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export interface ICRMAdapter {
  authenticate(): Promise<void>;
  getAssignedLeadIds(limit?: number, offset?: number): Promise<string[]>;
  getLeadProfile(leadId: string): Promise<LeadProfile>;
  tagLeadByQualification(leadId: string, qualStatus: 'hot' | 'warm' | 'ghost' | 'blocked'): Promise<void>;
  recordOutreach(leadId: string, record: any): Promise<void>;
  isDNC(phoneOrEmail: string): Promise<boolean>;
  recordDNC(phoneOrEmail: string, reason: string): Promise<void>;
  updateLeadState(leadId: string, stateKey: string, value: any): Promise<void>;
  getLeadState(leadId: string, stateKey: string): Promise<string | null>;
  healthCheck(): Promise<boolean>;
}
