import { LeadProfile, ICRMAdapter, CRMAdapterConfig } from './crmAdapter';

interface LoftyLeadData {
  id: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  email?: string;
  createdDate?: string;
  lastContactDate?: string;
  tags?: string[];
}

interface LeadsResponse {
  leads?: LoftyLeadData[];
}

export class LoftyCRMAdapter implements ICRMAdapter {
  private apiKey: string;
  private baseUrl = 'https://api.lofty.com/v2.0';
  private config: CRMAdapterConfig;

  constructor(config: CRMAdapterConfig) {
    this.apiKey = config.apiKey;
    this.config = config;
  }

  async authenticate(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/healthcheck`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!response.ok) throw new Error('Authentication failed');
    } catch (error) {
      throw new Error(`Lofty auth failed: ${error}`);
    }
  }

  async getAssignedLeadIds(limit = 100, offset = 0): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/leads?limit=${limit}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const result = (await response.json()) as LeadsResponse;
      return (result.leads || []).map((lead: LoftyLeadData) => lead.id);
    } catch (error) {
      console.error('[Lofty] Failed to get lead IDs:', error);
      return [];
    }
  }

  async getLeadProfile(leadId: string): Promise<LeadProfile> {
    try {
      const response = await fetch(`${this.baseUrl}/leads/${leadId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const data = (await response.json()) as LoftyLeadData;
      return {
        leadId: data.id,
        name: `${data.firstName || ''} ${data.lastName || ''}`.trim(),
        email: data.email,
        phone: data.phoneNumber,
        createdDate: data.createdDate ? new Date(data.createdDate) : new Date(),
        lastContactDate: data.lastContactDate ? new Date(data.lastContactDate) : undefined,
        tags: data.tags || [],
      };
    } catch (error) {
      throw new Error(`Failed to get lead profile for ${leadId}: ${error}`);
    }
  }

  async tagLeadByQualification(leadId: string, qualStatus: 'hot' | 'warm' | 'ghost' | 'blocked'): Promise<void> {
    const tagName = `VERN-QUAL-${qualStatus.toUpperCase()}`;
    try {
      await fetch(`${this.baseUrl}/leads/${leadId}/tags`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tag: tagName }),
      });
    } catch (error) {
      throw new Error(`Failed to tag lead ${leadId}: ${error}`);
    }
  }

  async recordOutreach(leadId: string, record: any): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/leads/${leadId}/activities`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(record),
      });
    } catch (error) {
      throw new Error(`Failed to record outreach for ${leadId}: ${error}`);
    }
  }

  async isDNC(phoneOrEmail: string): Promise<boolean> {
    // Placeholder - check against DNC list if available
    return false;
  }

  async recordDNC(phoneOrEmail: string, reason: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/dnc`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contact: phoneOrEmail, reason }),
      });
    } catch (error) {
      throw new Error(`Failed to record DNC for ${phoneOrEmail}: ${error}`);
    }
  }

  async updateLeadState(leadId: string, stateKey: string, value: any): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/leads/${leadId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ [stateKey]: value }),
      });
    } catch (error) {
      throw new Error(`Failed to update lead state for ${leadId}: ${error}`);
    }
  }

  async getLeadState(leadId: string, stateKey: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.baseUrl}/leads/${leadId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const data = (await response.json()) as Record<string, any>;
      return data[stateKey] || null;
    } catch (error) {
      console.error(`Failed to get lead state for ${leadId}:`, error);
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.authenticate();
      return true;
    } catch {
      return false;
    }
  }
}
