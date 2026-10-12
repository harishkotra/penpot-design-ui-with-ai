export interface Config {
  /** Penpot MCP endpoint. Must include ?userToken=<key> for self-hosted Penpot. */
  mcpUrl: string;
  /** OpenAI-compatible base URL, e.g. https://api.particle.ai/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type StepStatus = 'idle' | 'running' | 'ok' | 'error';

export interface Step {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  ms?: number;
}

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface RunOutcome {
  code: string;
  summary: unknown;
  image: string | null;
  execLog: string;
  model?: string;
  usage?: unknown;
}

export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  hint: string;
}