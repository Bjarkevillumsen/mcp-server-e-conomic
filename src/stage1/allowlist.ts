export const STAGE1_READ_TOOLS = [
  'economic_list_companies',
  'economic_get_company_context',
  'economic_describe_data',
  'economic_query',
  'economic_supplier_transactions',
] as const;

export const STAGE1_WRITE_TOOLS = [
  'economic_create_sales_invoice_draft',
  'economic_create_journal_draft_entry',
] as const;

export const STAGE1_ALLOWED_TOOLS = [
  ...STAGE1_READ_TOOLS,
  ...STAGE1_WRITE_TOOLS,
] as const;

export type Stage1ToolName = (typeof STAGE1_ALLOWED_TOOLS)[number];
export type Stage1ReadToolName = (typeof STAGE1_READ_TOOLS)[number];
export type Stage1WriteToolName = (typeof STAGE1_WRITE_TOOLS)[number];

const allowedTools = new Set<string>(STAGE1_ALLOWED_TOOLS);
const readTools = new Set<string>(STAGE1_READ_TOOLS);
const writeTools = new Set<string>(STAGE1_WRITE_TOOLS);

export function isStage1ToolName(value: string): value is Stage1ToolName {
  return allowedTools.has(value);
}

export function isStage1ReadTool(value: string): value is Stage1ReadToolName {
  return readTools.has(value);
}

export function isStage1WriteTool(value: string): value is Stage1WriteToolName {
  return writeTools.has(value);
}
