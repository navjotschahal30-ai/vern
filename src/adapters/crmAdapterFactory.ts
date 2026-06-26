import { ICRMAdapter, CRMAdapterConfig } from './crmAdapter';
import { LoftyCRMAdapter } from './loftyCRMAdapter';

let adapterInstance: ICRMAdapter | null = null;

export function getCRMAdapter(): ICRMAdapter {
  if (adapterInstance) return adapterInstance;

  const crmType = process.env.CRM_TYPE || 'lofty';

  if (crmType === 'lofty') {
    const config: CRMAdapterConfig & { teamId: string; userId: string } = {
      apiKey: process.env.LOFTY_API_KEY || '',
      teamId: process.env.LOFTY_TEAM_ID || '',
      userId: process.env.LOFTY_USER_ID || '',
      agentName: process.env.AGENT_NAME || 'Vern Agent',
      agentPhone: process.env.AGENT_PHONE || '',
      agentWebsite: process.env.AGENT_WEBSITE || '',
      logLevel: (process.env.LOG_LEVEL as any) || 'info',
    };
    adapterInstance = new LoftyCRMAdapter(config);
    console.log('[CRM] Initialized Lofty adapter');
    return adapterInstance;
  }

  throw new Error(`Unsupported CRM type: ${crmType}`);
}

export function resetAdapter(): void {
  adapterInstance = null;
}

// Backward compatibility layer - old code still works
export async function fetchAssignedLeadIds(limit?: number): Promise<string[]> {
  const adapter = getCRMAdapter();
  return adapter.getAssignedLeadIds(limit, 0);
}

export async function getLeadProfile(leadId: string) {
  const adapter = getCRMAdapter();
  return adapter.getLeadProfile(leadId);
}

export async function updateLeadState(leadId: string, stateKey: string, value: any): Promise<void> {
  const adapter = getCRMAdapter();
  return adapter.updateLeadState(leadId, stateKey, value);
}

export async function tagLeadByQualification(leadId: string, qualStatus: 'hot' | 'warm' | 'ghost' | 'blocked'): Promise<void> {
  const adapter = getCRMAdapter();
  return adapter.tagLeadByQualification(leadId, qualStatus);
}

export async function recordOutreach(leadId: string, type: 'sms' | 'email', content: string): Promise<void> {
  const adapter = getCRMAdapter();
  return adapter.recordOutreach(leadId, { leadId, type, content, timestamp: new Date(), success: true });
}

export async function isDNC(phoneOrEmail: string): Promise<boolean> {
  const adapter = getCRMAdapter();
  return adapter.isDNC(phoneOrEmail);
}

export async function recordDNC(phoneOrEmail: string, reason: string): Promise<void> {
  const adapter = getCRMAdapter();
  return adapter.recordDNC(phoneOrEmail, reason);
}

export async function healthCheck(): Promise<boolean> {
  try {
    const adapter = getCRMAdapter();
    return adapter.healthCheck();
  } catch (error) {
    console.error('[CRM] Health check failed:', error);
    return false;
  }
}
