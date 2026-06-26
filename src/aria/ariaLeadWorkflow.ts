import { getCRMAdapter } from '../adapters/crmAdapterFactory';
import * as fs from 'fs';
import * as path from 'path';

interface ConversationData {
  name: string;
  phone: string;
  email: string;
  propertyType: string;
  propertyCity: string;
  timeline: string;
  budget?: string;
  notes?: string;
}

interface ValidationResult {
  isValid: boolean;
  errors: Array<{ field: string; message: string }>;
  data?: ConversationData;
}

export class AriaLeadWorkflow {
  private logsDir = path.join(process.cwd(), 'logs', 'aria');

  constructor() {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  private validate(data: any): ValidationResult {
    const errors: Array<{ field: string; message: string }> = [];

    if (!data.name || data.name.trim().length < 2) {
      errors.push({ field: 'name', message: 'Name required' });
    }

    const phoneRegex = /^[\d\s\-\+\(\)]+$/;
    if (!data.phone || !phoneRegex.test(data.phone)) {
      errors.push({ field: 'phone', message: 'Invalid phone format' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (data.email && !emailRegex.test(data.email)) {
      errors.push({ field: 'email', message: 'Invalid email format' });
    }

    if (!data.propertyType || !['residential', 'commercial', 'industrial', 'land'].includes(data.propertyType.toLowerCase())) {
      errors.push({ field: 'propertyType', message: 'Invalid property type' });
    }

    if (!data.propertyCity || data.propertyCity.trim().length < 2) {
      errors.push({ field: 'propertyCity', message: 'City required' });
    }

    if (!data.timeline) {
      errors.push({ field: 'timeline', message: 'Timeline required' });
    }

    if (errors.length > 0) {
      return { isValid: false, errors };
    }

    return {
      isValid: true,
      errors: [],
      data: {
        name: data.name.trim(),
        phone: data.phone.trim(),
        email: data.email?.trim() || '',
        propertyType: data.propertyType.toLowerCase(),
        propertyCity: data.propertyCity.trim(),
        timeline: data.timeline,
        budget: data.budget?.trim() || '',
        notes: data.notes?.trim() || '',
      },
    };
  }

  private logErrorToFile(conversationId: string, errors: Array<{ field: string; message: string }>, rawData: any): void {
    const timestamp = new Date().toISOString();
    const errorLog = { timestamp, conversationId, errors, rawData, status: 'pending_manual_review' };
    const logFile = path.join(this.logsDir, `${conversationId}-error.json`);
    fs.writeFileSync(logFile, JSON.stringify(errorLog, null, 2));
    console.log(`[Aria] Error logged to ${logFile}`);
  }

  private createConversationSummary(data: ConversationData): string {
    const timestamp = new Date().toISOString();
    return `[Aria Intake - ${timestamp}]\n\nName: ${data.name}\nPhone: ${data.phone}\nEmail: ${data.email || '(not provided)'}\n\nLooking for: ${data.propertyType} in ${data.propertyCity}\nTimeline: ${data.timeline}\nBudget: ${data.budget || '(not provided)'}\n\nNotes: ${data.notes || '(none)'}\n\nStatus: Lead created via Aria chatbot.`;
  }

  async processConversation(conversationId: string, conversationData: any): Promise<{ success: boolean; leadId?: string; errors?: any[] }> {
    console.log(`[Aria] Processing conversation: ${conversationId}`);

    const validation = this.validate(conversationData);

    if (!validation.isValid) {
      console.log(`[Aria] Validation failed for ${conversationId}`);
      this.logErrorToFile(conversationId, validation.errors, conversationData);
      return { success: false, errors: validation.errors };
    }

    try {
      const adapter = getCRMAdapter();
      const data = validation.data!;
      console.log(`[Aria] Creating lead in CRM: ${data.name}`);

      const conversationSummary = this.createConversationSummary(data);
      const successLog = { timestamp: new Date().toISOString(), conversationId, leadData: data, summaryNote: conversationSummary, status: 'created_in_crm' };
      const logFile = path.join(this.logsDir, `${conversationId}-success.json`);
      fs.writeFileSync(logFile, JSON.stringify(successLog, null, 2));

      console.log(`[Aria] Lead created. Logged to ${logFile}`);
      return { success: true, leadId: conversationId };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[Aria] Failed to create lead:`, err.message);
      this.logErrorToFile(conversationId, [{ field: 'crm', message: err.message }], conversationData);
      return { success: false, errors: [{ field: 'crm', message: err.message }] };
    }
  }
}

export default new AriaLeadWorkflow();
