export const STAGE1_READ_TOOLS = [
  'stage1_list_companies',
  'stage1_check_connection',
  'stage1_get_company_context',
  'stage1_search_entities',
  'stage1_get_entity',
  'stage1_get_customer_overview',
  'stage1_get_supplier_overview',
  'stage1_get_product_overview',
  'stage1_get_accounting_entries',
  'stage1_get_sales_documents',
  'stage1_get_project_overview',
  'stage1_get_document',
  'stage1_get_report',
  'stage1_read_economic',
] as const;

export const STAGE1_WRITE_TOOLS = [
  'stage1_create_sales_invoice_draft',
  'stage1_create_journal_draft_entry',
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
