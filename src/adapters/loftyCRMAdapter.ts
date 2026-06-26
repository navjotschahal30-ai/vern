import { BaseAdapter } from './baseAdapter';
import { ICRMAdapter, LeadProfile, CRMAdapterConfig } from './crmAdapter';

interface LoftyLead {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  mobilePhone?: string;
  dateCreated?: string;
  tags?: Array<{ tagName: string }>;
  customFields?: Record<string, any>;
}

export class LoftyCRMAdapter extends BaseAdapter implements ICRMAdapter {
  private baseUrl = 'https://lofty.techstacks.com/api';
  private teamId: string;
  private userId: string;

  constructor(config: CRMAdapterConfig & { teamId: string; userId: string }) {
    super(config);
    this.teamId = config.teamId;
    this.userId = config.userId;
  }

  async authenticate(): Promise<void> {
    return this.handleError('authenticate', async () => {
      const response = await fetch(`${this.baseUrl}/teams/${this.teamId}/identity`, {
        headers: { Authorization: `token ${this.config.apiKey}` },
      });
      if (!response.ok) throw new Error(`Auth failed: ${response.status}`);
      this.log('info', 'Lofty authentication successful');
    });
  }

  async getAssignedLeadIds(limit: number = 100, offset: number = 0): Promise<string[]> {
    return this.handleError('getAssignedLeadIds', async () => {
      const params = new URLSearchParams({
        assignedUserId: this.userId,
        limit: String(limit),
        offset: String(offset),
      });
      const response = await fetch(`${this.baseUrl}/teams/${this.teamId}/leads?${params}`, {
        headers: { Authorization: `token ${this.config.apiKey}` },
      });
      if (!response.ok) throw new Error(`Failed to fetch leads: ${response.status}`);
      const data = await response.json();
      const leadIds = (data.leads || []).map((lead: LoftyLead) => lead.id);
      this.log('debug', `Fetched ${leadIds.length} lead IDs`);
      return leadIds;
    });
  }

  async getLeadProfile(leadId: string): Promise<LeadProfile> {
    return this.handleError('getLeadProfile', async () => {
      const response = await fetch(`${this.baseUrl}/teams/${this.teamId}/leads/${leadId}`, {
        headers: { Authorization: `token ${this.config.apiKey}` },
      });
      if (!response.ok) throw new Error(`Failed to fetch lead: ${response.status}`);
      const data: LoftyLead = await response.json();
      return this.mapLoftyLeadToProfile(data);
    });
  }

  async tagLeadByQualification(leadId: string, qualStatus: 'hot' | 'warm' | 'ghost' | 'blocked'): Promise<void> {
    return this.handleError('tagLeadByQualification', async () => {
      const tagName = `VERN-QUAL-${qualStatus.toUpperCase()}`;
      const response = await fetch(`${this.baseUrl}/teams/${this.teamId}/leads/${leadId}/tags`, {
        method: 'POST',
        headers: { Authorization: `token ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName }),
      });
      if (!response.ok) throw new Error(`Failed to tag lead: ${response.status}`);
      this.log('debug', `Tagged lead ${leadId} as ${qualStatus}`);
    });
  }

  async recordOutreach(leadId: string, record: any): Promise<void> {
    return this.handleError('recordOutreach', async () => {
      const noteContent = `[${record.type.toUpperCase()}] ${record.content}`;
      const response = await fetch(`${this.baseUrl}/teams/${this.teamId}/leads/${leadId}/notes`, {
        method: 'POST',
        headers: { Authorization: `token ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent }),
      });
      if (!response.ok) throw new Error(`Failed to record outreach: ${response.status}`);
      this.log('debug', `Recorded ${record.type} for lead ${leadId}`);
    });
  }

  async updateLeadState(leadId: string, stateKey: string, value: any): Promise<void> {
    return this.handleError('updateLeadState', async () => {
      const tagValue = typeof value === 'object' ? value.toISOString() : String(value);
      const tagName = `${stateKey}:${tagValue}`;
      const response = await fetch(`${this.baseUrl}/teams/${this.teamId}/leads/${leadId}/tags`, {
        method: 'POST',
        headers: { Authorization: `token ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName }),
      });
      if (!response.ok) throw new Error(`Failed to update lead state: ${response.status}`);
      this.log('debug', `Updated lead state: ${stateKey}=${tagValue}`);
    });
  }

  async getLeadState(leadId: string, stateKey: string): Promise<string | null> {
    return this.handleError('getLeadState', async () => {
      const profile = await this.getLeadProfile(leadId);
      const stateTag = profile.tags.find(tag => tag.startsWith(stateKey + ':'));
      return stateTag ? stateTag.substring(stateKey.length + 1) : null;
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.authenticate();
      return true;
    } catch {
      return false;
    }
  }

  private mapLoftyLeadToProfile(loftyLead: LoftyLead): LeadProfile {
    const name = [loftyLead.firstName, loftyLead.lastName].filter(Boolean).join(' ') || 'Unknown';
    const phone = loftyLead.mobilePhone || loftyLead.phone;
    const createdDate = loftyLead.dateCreated ? new Date(loftyLead.dateCreated) : new Date();
    const tags = (loftyLead.tags || []).map(t => t.tagName);
    return { leadId: loftyLead.id, name, email: loftyLead.email, phone, createdDate, tags, customFields: loftyLead.customFields || {} };
  }
}
