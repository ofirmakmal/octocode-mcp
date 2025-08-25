import { z } from 'zod';
import {
  extendBaseQuerySchema,
  createBulkQuerySchema,
  GitHubOwnerSchema,
  GitHubRepoSchema,
  GitHubFilePathSchema,
  GitHubBranchSchema,
} from './baseSchema';

export const FileContentQuerySchema = extendBaseQuerySchema({
  owner: GitHubOwnerSchema,
  repo: GitHubRepoSchema,
  filePath: GitHubFilePathSchema.describe(
    `File path from repository root (e.g., 'src/index.js', 'README.md', 'docs/api.md'). Do NOT start with slash.
        
        CRITICAL: Always verify file paths using githubViewRepoStructure and githubSearchCode before fetching to ensure accurate research results.`
  ),
  branch: GitHubBranchSchema.optional(),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Starting line number (1-based) for partial file access. Recommended to save tokens.`
    ),
  endLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Ending line number (1-based) for partial file access. Use with startLine to fetch only specific sections and save tokens.`
    ),
  matchString: z
    .string()
    .optional()
    .describe(
      `Exact string to find in file. Returns surrounding context with matchStringContextLines. Perfect for locating specific code patterns found in search results text_matches. Content is processed through the same pipeline as code search for consistency.`
    ),
  matchStringContextLines: z
    .number()
    .int()
    .min(0)
    .max(50)
    .default(5)
    .describe(
      `Number of lines to include above and below a matched string. For example, 5 means 5 lines above + the matching line + 5 lines below. Only used when matchString is provided. Default: 5.`
    ),
  minified: z
    .boolean()
    .default(true)
    .describe(
      `Optimize content for token efficiency (enabled by default). Applies basic formatting optimizations that may reduce token usage. Set to false only when exact formatting is required.`
    ),
});

export type FileContentQuery = z.infer<typeof FileContentQuerySchema>;

// Bulk schema for multiple file content queries
export const FileContentBulkQuerySchema = createBulkQuerySchema(
  FileContentQuerySchema,
  1,
  10,
  'Array of up to 10 file content queries for parallel execution'
);

export interface FileContentQueryResult {
  queryId?: string;
  researchGoal?: string;
  originalQuery?: FileContentQuery; // Only included on error or not found
  result: GitHubFileContentResponse | { error: string; hints?: string[] };
  error?: string;
  sampling?: {
    codeExplanation: string;
    filePath: string;
    repo: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    stopReason?: string;
  }; // Beta feature: LLM explanation of what the code is doing
}
export interface GitHubFileContentResponse {
  filePath: string;
  owner: string;
  repo: string;
  branch: string;
  content: string;
  // Actual content boundaries (with context applied)
  startLine?: number;
  endLine?: number;
  totalLines: number; // Always returned - total lines in the file
  isPartial?: boolean;
  minified?: boolean;
  minificationFailed?: boolean;
  minificationType?:
    | 'terser'
    | 'conservative'
    | 'aggressive'
    | 'json'
    | 'general'
    | 'markdown'
    | 'failed'
    | 'none';
  // Security metadata
  securityWarnings?: string[];
}

export interface GithubFetchRequestParams {
  owner: string;
  repo: string;
  branch?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  matchString?: string;
  matchStringContextLines?: number;
  minified: boolean;
}

export interface GitHubFileContentError {
  error: string;
  status?: number;
  hints?: string[];
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  scopesSuggestion?: string;
  type?: 'http' | 'graphql' | 'network' | 'unknown';
}
