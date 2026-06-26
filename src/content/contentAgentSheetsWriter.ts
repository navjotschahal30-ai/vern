import { google } from 'googleapis';

interface ContentRow {
  Date: string;
  Pillar: string;
  Platform: string;
  Hook: string;
  Body: string;
  CTA: string;
  ImageSpec: string;
  Status: string;
  Notes: string;
}

interface MarketIntelligenceRow {
  Date: string;
  City: string;
  Metric: string;
  Value: string;
  Trend: string;
  Insight: string;
  BlogReady: string;
  Status: string;
}

export class ContentAgentSheetsWriter {
  private sheetsApi: any;
  private spreadsheetId: string;

  constructor(spreadsheetId: string, credentials: any) {
    this.spreadsheetId = spreadsheetId;
    this.sheetsApi = google.sheets({ version: 'v4', auth: credentials });
  }

  async writeContentTab(contentRows: ContentRow[]): Promise<void> {
    console.log(`[Content Agent] Writing ${contentRows.length} rows to Content tab`);
    const range = 'Content!A2:I';
    const values = contentRows.map(row => [row.Date, row.Pillar, row.Platform, row.Hook, row.Body, row.CTA, row.ImageSpec, row.Status, row.Notes]);

    try {
      await this.sheetsApi.spreadsheets.values.clear({
        spreadsheetId: this.spreadsheetId,
        range: `Content!A2:I1000`,
      });
      await this.sheetsApi.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      });
      console.log(`[Content Agent] Content tab updated`);
    } catch (error) {
      console.error(`[Content Agent] Failed to write Content tab:`, error);
      throw error;
    }
  }

  async writeMarketIntelligenceTab(marketRows: MarketIntelligenceRow[]): Promise<void> {
    console.log(`[Content Agent] Writing ${marketRows.length} rows to Market Intelligence tab`);
    const range = 'Market Intelligence!A2:H';
    const values = marketRows.map(row => [row.Date, row.City, row.Metric, row.Value, row.Trend, row.Insight, row.BlogReady, row.Status]);

    try {
      await this.sheetsApi.spreadsheets.values.clear({
        spreadsheetId: this.spreadsheetId,
        range: `'Market Intelligence'!A2:H1000`,
      });
      await this.sheetsApi.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      });
      console.log(`[Content Agent] Market Intelligence tab updated`);
    } catch (error) {
      console.error(`[Content Agent] Failed to write Market Intelligence tab:`, error);
      throw error;
    }
  }

  async deleteOtherTabs(): Promise<void> {
    console.log(`[Content Agent] Cleaning up old tabs...`);
    try {
      const spreadsheet = await this.sheetsApi.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
      const sheetsToDelete = spreadsheet.data.sheets
        .filter((sheet: any) => !['Content', 'Market Intelligence'].includes(sheet.properties.title))
        .map((sheet: any) => sheet.properties.sheetId);

      if (sheetsToDelete.length === 0) {
        console.log(`[Content Agent] No old tabs to delete`);
        return;
      }

      const requests = sheetsToDelete.map((sheetId: number) => ({ deleteSheet: { sheetId } }));
      await this.sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests },
      });
      console.log(`[Content Agent] Deleted ${sheetsToDelete.length} old tabs`);
    } catch (error) {
      console.error(`[Content Agent] Failed to delete old tabs:`, error);
    }
  }

  async updateSheets(contentRows: ContentRow[], marketRows: MarketIntelligenceRow[]): Promise<void> {
    console.log(`[Content Agent] Updating Google Sheets...`);
    try {
      await this.writeContentTab(contentRows);
      await this.writeMarketIntelligenceTab(marketRows);
      await this.deleteOtherTabs();
      console.log(`[Content Agent] Google Sheets updated successfully`);
    } catch (error) {
      console.error(`[Content Agent] Failed to update sheets:`, error);
      throw error;
    }
  }
}
