import type {
  SearchReposParameters,
  RepoSearchResultItem,
  GitHubAPIResponse,
  Repository,
} from '../../types/github-openapi';
import { GitHubReposSearchQuery } from '../../mcp/tools/scheme/github_search_repos';
import { getOctokit } from './client';
import { handleGitHubAPIError } from './errors';
import { buildRepoSearchQuery } from './queryBuilders';
import { generateCacheKey, withCache } from '../cache';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';
import { createResult } from '../../mcp/responses';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types';

/**
 * Search GitHub repositories using Octokit API with proper TypeScript types and caching
 * Token management is handled internally by the GitHub client
 */
export async function searchGitHubReposAPI(
  params: GitHubReposSearchQuery,
  authInfo?: AuthInfo,
  sessionId?: string
): Promise<
  GitHubAPIResponse<{ total_count: number; repositories: Repository[] }>
> {
  // Generate cache key based on search parameters only (NO TOKEN DATA)
  const cacheKey = generateCacheKey('gh-api-repos', params, sessionId);

  // Create a wrapper function that returns CallToolResult for the cache
  const searchOperation = async (): Promise<CallToolResult> => {
    const result = await searchGitHubReposAPIInternal(params, authInfo);

    // Convert to CallToolResult for caching
    if ('error' in result) {
      return createResult({
        isError: true,
        data: result,
      });
    } else {
      return createResult({
        data: result,
      });
    }
  };

  // Use cache with 2-hour TTL (configured in cache.ts)
  const cachedResult = await withCache(cacheKey, searchOperation);

  // Convert CallToolResult back to the expected format
  if (cachedResult.isError) {
    // Extract the actual error data from the CallToolResult
    const jsonText = (cachedResult.content[0] as { text: string }).text;
    const parsedData = JSON.parse(jsonText);
    return parsedData.data as GitHubAPIResponse<{
      total_count: number;
      repositories: Repository[];
    }>;
  } else {
    // Extract the actual success data from the CallToolResult
    const jsonText = (cachedResult.content[0] as { text: string }).text;
    const parsedData = JSON.parse(jsonText);
    return parsedData.data as GitHubAPIResponse<{
      total_count: number;
      repositories: Repository[];
    }>;
  }
}

/**
 * Internal implementation of searchGitHubReposAPI without caching
 */
async function searchGitHubReposAPIInternal(
  params: GitHubReposSearchQuery,
  authInfo?: AuthInfo
): Promise<
  GitHubAPIResponse<{ total_count: number; repositories: Repository[] }>
> {
  try {
    const octokit = await getOctokit(authInfo);
    const query = buildRepoSearchQuery(params);

    if (!query.trim()) {
      return {
        error: 'Search query cannot be empty. Provide queryTerms or filters.',
        type: 'http',
        status: 400,
      };
    }

    // Use properly typed parameters
    const searchParams: SearchReposParameters = {
      q: query,
      per_page: Math.min(params.limit || 30, 100),
      page: 1,
    };

    // Add sort and order if specified
    if (params.sort && params.sort !== 'best-match') {
      searchParams.sort = params.sort as SearchReposParameters['sort'];
    }
    if (params.order) {
      searchParams.order = params.order as SearchReposParameters['order'];
    }

    const result = await octokit.rest.search.repos(searchParams);

    // Transform repository results to match CLI format with proper typing
    const repositories = result.data.items.map(
      (repo: RepoSearchResultItem) => ({
        name: repo.full_name,
        stars: repo.stargazers_count || 0,
        description: repo.description
          ? repo.description.length > 150
            ? repo.description.substring(0, 150) + '...'
            : repo.description
          : 'No description',
        language: repo.language || 'Unknown',
        url: repo.html_url,
        forks: repo.forks || 0,
        updatedAt: new Date(repo.updated_at).toLocaleDateString('en-GB'),
        owner: repo.owner?.login || 'Unknown',
      })
    );

    return {
      data: {
        total_count: result.data.total_count,
        repositories,
      },
      status: 200,
      headers: result.headers,
    };
  } catch (error: unknown) {
    return handleGitHubAPIError(error);
  }
}
