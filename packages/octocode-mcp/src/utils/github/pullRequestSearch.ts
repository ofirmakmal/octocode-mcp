import {
  GitHubPullRequestsSearchParams,
  GitHubPullRequestItem,
} from '../../types/github-openapi';
import type { components } from '@octokit/openapi-types';
import {
  GitHubPullRequestSearchResult,
  GitHubPullRequestSearchError,
} from '../../mcp/tools/scheme/github_search_pull_requests';

// GitHub API types for pull request files
type DiffEntry = components['schemas']['diff-entry'];
import { ContentSanitizer } from '../../security/contentSanitizer';
import { getOctokit, OctokitWithThrottling } from './client';
import { handleGitHubAPIError } from './errors';
import {
  buildPullRequestSearchQuery,
  shouldUseSearchForPRs,
} from './queryBuilders';
import { generateCacheKey, withCache } from '../cache';
import { createResult } from '../../mcp/responses';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types';

/**
 * Search GitHub pull requests using Octokit API with caching
 * Token management is handled internally by the GitHub client
 */
export async function searchGitHubPullRequestsAPI(
  params: GitHubPullRequestsSearchParams,
  authInfo?: AuthInfo,
  sessionId?: string
): Promise<GitHubPullRequestSearchResult | GitHubPullRequestSearchError> {
  // Generate cache key based on search parameters only (NO TOKEN DATA)
  const cacheKey = generateCacheKey('gh-api-prs', params, sessionId);

  // Create a wrapper function that returns CallToolResult for the cache
  const searchOperation = async (): Promise<CallToolResult> => {
    const result = await searchGitHubPullRequestsAPIInternal(params, authInfo);

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

  // Use cache with 30-minute TTL (configured in cache.ts)
  const cachedResult = await withCache(cacheKey, searchOperation);

  // Convert CallToolResult back to the expected format
  if (cachedResult.isError) {
    // Extract the actual error data from the CallToolResult
    const jsonText = (cachedResult.content[0] as { text: string }).text;
    const parsedData = JSON.parse(jsonText);
    return parsedData.data as GitHubPullRequestSearchError;
  } else {
    // Extract the actual success data from the CallToolResult
    const jsonText = (cachedResult.content[0] as { text: string }).text;
    const parsedData = JSON.parse(jsonText);
    return parsedData.data as GitHubPullRequestSearchResult;
  }
}

/**
 * Internal implementation of searchGitHubPullRequestsAPI without caching
 */
async function searchGitHubPullRequestsAPIInternal(
  params: GitHubPullRequestsSearchParams,
  authInfo?: AuthInfo
): Promise<GitHubPullRequestSearchResult | GitHubPullRequestSearchError> {
  try {
    // If prNumber is provided with owner/repo, fetch specific PR by number
    if (
      params.prNumber &&
      params.owner &&
      params.repo &&
      !Array.isArray(params.owner) &&
      !Array.isArray(params.repo)
    ) {
      return await fetchGitHubPullRequestByNumberAPIInternal(params, authInfo);
    }

    const octokit = await getOctokit(authInfo);

    // Decide between search and list based on filters
    const shouldUseSearch = shouldUseSearchForPRs(params);

    if (
      !shouldUseSearch &&
      params.owner &&
      params.repo &&
      !Array.isArray(params.owner) &&
      !Array.isArray(params.repo)
    ) {
      // Use REST API for simple repository-specific searches (like gh pr list)
      return await searchPullRequestsWithREST(octokit, params);
    }

    // Use Search API for complex queries (like gh search prs)
    const searchQuery = buildPullRequestSearchQuery(params);

    if (!searchQuery) {
      return {
        error: 'No valid search parameters provided',
        status: 400,
        hints: ['Provide search query or filters like owner/repo'],
      };
    }

    // Execute search using GitHub Search API (issues endpoint filters PRs)
    const searchResult = await octokit.rest.search.issuesAndPullRequests({
      q: searchQuery,
      sort:
        params.sort && params.sort !== 'best-match' ? params.sort : undefined,
      order: params.order || 'desc',
      per_page: Math.min(params.limit || 30, 100),
    });

    const pullRequests =
      searchResult.data.items?.filter(
        (item: Record<string, unknown>) => item.pull_request
      ) || [];

    // Transform pull requests to our expected format
    const transformedPRs: GitHubPullRequestItem[] = await Promise.all(
      pullRequests.map(async (item: Record<string, unknown>) => {
        return await transformPullRequestItem(item, params, octokit);
      })
    );

    // Transform to expected GitHub API format
    const formattedPRs = transformedPRs.map(pr => ({
      id: 0, // We don't have this in our format
      number: pr.number,
      title: pr.title,
      url: pr.url,
      html_url: pr.url,
      state: pr.state as 'open' | 'closed',
      draft: pr.draft,
      merged: pr.state === 'closed' && !!pr.merged_at,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      closed_at: pr.closed_at,
      merged_at: pr.merged_at,
      user: {
        login: pr.author,
        id: 0,
        avatar_url: '',
        html_url: `https://github.com/${pr.author}`,
      },
      head: {
        ref: pr.head || '',
        sha: pr.head_sha || '',
      },
      base: {
        ref: pr.base || '',
        sha: pr.base_sha || '',
        repo: {
          id: 0,
          name: pr.repository.split('/')[1] || '',
          full_name: pr.repository,
          owner: {
            login: pr.repository.split('/')[0] || '',
            id: 0,
          },
          private: false,
          html_url: `https://github.com/${pr.repository}`,
          default_branch: 'main',
        },
      },
      body: pr.body,
      comments: pr.comments?.length || 0,
      review_comments: 0,
      commits: 0,
      additions:
        pr.file_changes?.files.reduce((sum, file) => sum + file.additions, 0) ||
        0,
      deletions:
        pr.file_changes?.files.reduce((sum, file) => sum + file.deletions, 0) ||
        0,
      changed_files: pr.file_changes?.total_count || 0,
      // Include file_changes if it was requested and fetched
      ...(pr.file_changes && { file_changes: pr.file_changes }),
    }));

    return {
      total_count: searchResult.data.total_count,
      incomplete_results: searchResult.data.incomplete_results,
      pull_requests: formattedPRs,
    };
  } catch (error: unknown) {
    const apiError = handleGitHubAPIError(error);
    return {
      error: `Pull request search failed: ${apiError.error}`,
      status: apiError.status,
      rateLimitRemaining: apiError.rateLimitRemaining,
      rateLimitReset: apiError.rateLimitReset,
      hints: [`Verify authentication and search parameters`],
      type: apiError.type,
    };
  }
}

/**
 * Use REST API for simple repository-specific searches (like gh pr list)
 */
async function searchPullRequestsWithREST(
  octokit: InstanceType<typeof OctokitWithThrottling>,
  params: GitHubPullRequestsSearchParams
): Promise<GitHubPullRequestSearchResult | GitHubPullRequestSearchError> {
  try {
    const owner = params.owner as string;
    const repo = params.repo as string;

    // Use pulls.list for simple repository searches
    const listParams: Record<string, unknown> = {
      owner,
      repo,
      state: params.state || 'open',
      per_page: Math.min(params.limit || 30, 100),
      // REST API only supports 'created' and 'updated' sort for pulls.list
      sort: params.sort === 'updated' ? 'updated' : 'created',
      direction: params.order || 'desc',
    };

    // Add simple filters that REST API supports
    if (params.head) listParams.head = params.head;
    if (params.base) listParams.base = params.base;

    const result = await octokit.rest.pulls.list(listParams);

    // Transform to our expected format
    const transformedPRs: GitHubPullRequestItem[] = await Promise.all(
      result.data.map(async (item: Record<string, unknown>) => {
        return await transformPullRequestItemFromREST(item, params, octokit);
      })
    );

    // Transform to expected GitHub API format
    const formattedPRs = transformedPRs.map(pr => ({
      id: 0,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      html_url: pr.url,
      state: pr.state as 'open' | 'closed',
      draft: pr.draft,
      merged: pr.state === 'closed' && !!pr.merged_at,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      closed_at: pr.closed_at,
      merged_at: pr.merged_at,
      user: {
        login: pr.author,
        id: 0,
        avatar_url: '',
        html_url: `https://github.com/${pr.author}`,
      },
      head: {
        ref: pr.head || '',
        sha: pr.head_sha || '',
      },
      base: {
        ref: pr.base || '',
        sha: pr.base_sha || '',
        repo: {
          id: 0,
          name: pr.repository.split('/')[1] || '',
          full_name: pr.repository,
          owner: {
            login: pr.repository.split('/')[0] || '',
            id: 0,
          },
          private: false,
          html_url: `https://github.com/${pr.repository}`,
          default_branch: 'main',
        },
      },
      body: pr.body,
      comments: pr.comments?.length || 0,
      review_comments: 0,
      commits: 0,
      additions:
        pr.file_changes?.files.reduce((sum, file) => sum + file.additions, 0) ||
        0,
      deletions:
        pr.file_changes?.files.reduce((sum, file) => sum + file.deletions, 0) ||
        0,
      changed_files: pr.file_changes?.total_count || 0,
      // Include file_changes if it was requested and fetched
      ...(pr.file_changes && { file_changes: pr.file_changes }),
    }));

    return {
      total_count: formattedPRs.length,
      incomplete_results: false,
      pull_requests: formattedPRs,
    };
  } catch (error: unknown) {
    const apiError = handleGitHubAPIError(error);
    return {
      error: `Pull request list failed: ${apiError.error}`,
      status: apiError.status,
      rateLimitRemaining: apiError.rateLimitRemaining,
      rateLimitReset: apiError.rateLimitReset,
      hints: [`Verify repository access and authentication`],
      type: apiError.type,
    };
  }
}

/**
 * Transform pull request item from Search API response
 */
async function transformPullRequestItem(
  item: Record<string, unknown>,
  params: GitHubPullRequestsSearchParams,
  octokit: InstanceType<typeof OctokitWithThrottling>
): Promise<GitHubPullRequestItem> {
  // Sanitize title and body content
  const titleSanitized = ContentSanitizer.sanitizeContent(
    (item.title as string) || ''
  );
  const bodySanitized = item.body
    ? ContentSanitizer.sanitizeContent(item.body as string)
    : { content: undefined, warnings: [] };

  // Collect all sanitization warnings
  const sanitizationWarnings = new Set<string>([
    ...titleSanitized.warnings,
    ...bodySanitized.warnings,
  ]);

  const result: GitHubPullRequestItem = {
    number: item.number as number,
    title: titleSanitized.content,
    body: bodySanitized.content,
    state: ((item.state as string)?.toLowerCase() || 'unknown') as
      | 'open'
      | 'closed',
    author: ((item.user as Record<string, unknown>)?.login as string) || '',
    repository: `${params.owner}/${params.repo}`,
    labels:
      (item.labels as Array<Record<string, unknown>>)?.map(
        (l: Record<string, unknown>) => l.name as string
      ) || [],
    created_at: item.created_at
      ? new Date(item.created_at as string).toLocaleDateString('en-GB')
      : '',
    updated_at: item.updated_at
      ? new Date(item.updated_at as string).toLocaleDateString('en-GB')
      : '',
    url: item.html_url as string,
    comments: [], // Will be populated if withComments is true
    reactions: 0, // REST API doesn't provide reactions in list
    draft: (item.draft as boolean) || false,
    head: (item.head as Record<string, unknown>)?.ref as string,
    head_sha: (item.head as Record<string, unknown>)?.sha as string,
    base: (item.base as Record<string, unknown>)?.ref as string,
    base_sha: (item.base as Record<string, unknown>)?.sha as string,
  };

  // Add sanitization warnings if any were detected
  if (sanitizationWarnings.size > 0) {
    result._sanitization_warnings = Array.from(sanitizationWarnings);
  }

  // Add optional fields
  if (item.closed_at) {
    result.closed_at = new Date(item.closed_at as string).toLocaleDateString(
      'en-GB'
    );
  }

  // Get additional PR details if needed (head/base SHA, etc.)
  if (params.getFileChanges || item.pull_request) {
    try {
      const [owner, repo] = result.repository.split('/');
      if (owner && repo) {
        const prDetails = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: item.number,
        });

        if (prDetails.data) {
          result.head = prDetails.data.head?.ref;
          result.head_sha = prDetails.data.head?.sha;
          result.base = prDetails.data.base?.ref;
          result.base_sha = prDetails.data.base?.sha;
          result.draft = prDetails.data.draft || false;

          // Fetch file changes if requested
          if (params.getFileChanges) {
            const fileChanges = await fetchPRFileChangesAPI(
              owner,
              repo,
              item.number as number
            );
            if (fileChanges) {
              result.file_changes = fileChanges;
            }
          }
        }
      }
    } catch (e) {
      // Continue without additional details if API call fails
    }
  }

  // Fetch comments if requested
  if (params.withComments) {
    try {
      const [owner, repo] = result.repository.split('/');
      if (owner && repo) {
        const commentsResult = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: item.number,
        });

        result.comments = commentsResult.data.map(
          (comment: Record<string, unknown>) => ({
            id: comment.id as string,
            user:
              ((comment.user as Record<string, unknown>)?.login as string) ||
              'unknown',
            body: ContentSanitizer.sanitizeContent(
              (comment.body as string) || ''
            ).content,
            created_at: new Date(
              comment.created_at as string
            ).toLocaleDateString('en-GB'),
            updated_at: new Date(
              comment.updated_at as string
            ).toLocaleDateString('en-GB'),
          })
        );
      }
    } catch (e) {
      // Continue without comments if API call fails
    }
  }

  return result;
}

/**
 * Fetch file changes for a pull request using GitHub API
 * Returns proper GitHub API types for pull request files
 */
async function fetchPRFileChangesAPI(
  owner: string,
  repo: string,
  prNumber: number,
  authInfo?: AuthInfo
): Promise<{ total_count: number; files: DiffEntry[] } | null> {
  try {
    const octokit = await getOctokit(authInfo);
    const result = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });

    // result.data is already properly typed as DiffEntry[] from GitHub API
    const files: DiffEntry[] = result.data;

    return {
      total_count: files.length,
      files,
    };
  } catch (error) {
    // Return null if file changes fetch fails
    return null;
  }
}

/**
 * Transform pull request item from REST API response
 */
export async function transformPullRequestItemFromREST(
  item: Record<string, unknown>,
  params: GitHubPullRequestsSearchParams,
  octokit: InstanceType<typeof OctokitWithThrottling>,
  authInfo?: AuthInfo
): Promise<GitHubPullRequestItem> {
  // Sanitize title and body content
  const titleSanitized = ContentSanitizer.sanitizeContent(
    (item.title as string) || ''
  );
  const bodySanitized = item.body
    ? ContentSanitizer.sanitizeContent(item.body as string)
    : { content: undefined, warnings: [] };

  // Collect all sanitization warnings
  const sanitizationWarnings = new Set<string>([
    ...titleSanitized.warnings,
    ...bodySanitized.warnings,
  ]);

  const result: GitHubPullRequestItem = {
    number: item.number as number,
    title: titleSanitized.content,
    body: bodySanitized.content,
    state: ((item.state as string)?.toLowerCase() || 'unknown') as
      | 'open'
      | 'closed',
    author: ((item.user as Record<string, unknown>)?.login as string) || '',
    repository: `${params.owner}/${params.repo}`,
    labels:
      (item.labels as Array<Record<string, unknown>>)?.map(
        (l: Record<string, unknown>) => l.name as string
      ) || [],
    created_at: item.created_at
      ? new Date(item.created_at as string).toLocaleDateString('en-GB')
      : '',
    updated_at: item.updated_at
      ? new Date(item.updated_at as string).toLocaleDateString('en-GB')
      : '',
    url: item.html_url as string,
    comments: [], // Will be populated if withComments is true
    reactions: 0, // REST API doesn't provide reactions in list
    draft: (item.draft as boolean) || false,
    head: (item.head as Record<string, unknown>)?.ref as string,
    head_sha: (item.head as Record<string, unknown>)?.sha as string,
    base: (item.base as Record<string, unknown>)?.ref as string,
    base_sha: (item.base as Record<string, unknown>)?.sha as string,
  };

  // Add sanitization warnings if any were detected
  if (sanitizationWarnings.size > 0) {
    result._sanitization_warnings = Array.from(sanitizationWarnings);
  }

  // Add optional fields
  if (item.closed_at) {
    result.closed_at = new Date(item.closed_at as string).toLocaleDateString(
      'en-GB'
    );
  }
  if (item.merged_at) {
    result.merged_at = new Date(item.merged_at as string).toLocaleDateString(
      'en-GB'
    );
  }

  // Fetch file changes if requested
  if (params.getFileChanges) {
    const fileChanges = await fetchPRFileChangesAPI(
      params.owner as string,
      params.repo as string,
      item.number as number,
      authInfo
    );
    if (fileChanges) {
      result.file_changes = fileChanges;
    }
  }

  // Fetch comments if requested
  if (params.withComments) {
    try {
      const commentsResult = await octokit.rest.issues.listComments({
        owner: params.owner as string,
        repo: params.repo as string,
        issue_number: item.number as number,
      });

      result.comments = commentsResult.data.map(
        (comment: Record<string, unknown>) => ({
          id: comment.id as string,
          user:
            ((comment.user as Record<string, unknown>)?.login as string) ||
            'unknown',
          body: ContentSanitizer.sanitizeContent((comment.body as string) || '')
            .content,
          created_at: new Date(comment.created_at as string).toLocaleDateString(
            'en-GB'
          ),
          updated_at: new Date(comment.updated_at as string).toLocaleDateString(
            'en-GB'
          ),
        })
      );
    } catch (e) {
      // Continue without comments if API call fails
    }
  }

  return result;
}

/**
 * Fetch a specific pull request by number using GitHub REST API
 * More efficient than search when we know the exact PR number
 */
export async function fetchGitHubPullRequestByNumberAPI(
  params: GitHubPullRequestsSearchParams,
  authInfo?: AuthInfo,
  sessionId?: string
): Promise<GitHubPullRequestSearchResult | GitHubPullRequestSearchError> {
  // Generate cache key for specific PR fetch (NO TOKEN DATA)
  const cacheKey = generateCacheKey(
    'gh-api-prs',
    {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      getFileChanges: params.getFileChanges,
      withComments: params.withComments,
    },
    sessionId
  );

  // Create a wrapper function that returns CallToolResult for the cache
  const fetchOperation = async (): Promise<CallToolResult> => {
    const result = await fetchGitHubPullRequestByNumberAPIInternal(
      params,
      authInfo
    );

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

  // Use cache with 30-minute TTL (configured in cache.ts)
  const cachedResult = await withCache(cacheKey, fetchOperation);

  // Convert CallToolResult back to the expected format
  if (cachedResult.isError) {
    // Extract the actual error data from the CallToolResult
    const jsonText = (cachedResult.content[0] as { text: string }).text;
    const parsedData = JSON.parse(jsonText);
    return parsedData.data as GitHubPullRequestSearchError;
  } else {
    // Extract the actual success data from the CallToolResult
    const jsonText = (cachedResult.content[0] as { text: string }).text;
    const parsedData = JSON.parse(jsonText);
    return parsedData.data as GitHubPullRequestSearchResult;
  }
}

/**
 * Internal implementation of fetchGitHubPullRequestByNumberAPI without caching
 */
async function fetchGitHubPullRequestByNumberAPIInternal(
  params: GitHubPullRequestsSearchParams,
  authInfo?: AuthInfo
): Promise<GitHubPullRequestSearchResult | GitHubPullRequestSearchError> {
  try {
    const octokit = await getOctokit(authInfo);

    // Extract values from params
    const owner = params.owner as string;
    const repo = params.repo as string;
    const prNumber = params.prNumber!;

    // Use REST API to get specific PR by number
    const result = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const pr = result.data;

    // Transform to our expected format
    const transformedPR: GitHubPullRequestItem =
      await transformPullRequestItemFromREST(pr, params, octokit, authInfo);

    // Transform to expected GitHub API format
    const formattedPR = {
      id: 0,
      number: transformedPR.number,
      title: transformedPR.title,
      url: transformedPR.url,
      html_url: transformedPR.url,
      state: transformedPR.state as 'open' | 'closed',
      draft: transformedPR.draft,
      merged: transformedPR.state === 'closed' && !!transformedPR.merged_at,
      created_at: transformedPR.created_at,
      updated_at: transformedPR.updated_at,
      closed_at: transformedPR.closed_at,
      merged_at: transformedPR.merged_at,
      user: {
        login: transformedPR.author,
        id: 0,
        avatar_url: '',
        html_url: `https://github.com/${transformedPR.author}`,
      },
      head: {
        ref: transformedPR.head || '',
        sha: transformedPR.head_sha || '',
      },
      base: {
        ref: transformedPR.base || '',
        sha: transformedPR.base_sha || '',
        repo: {
          id: 0,
          name: transformedPR.repository.split('/')[1] || '',
          full_name: transformedPR.repository,
          owner: {
            login: transformedPR.repository.split('/')[0] || '',
            id: 0,
          },
          private: false,
          html_url: `https://github.com/${transformedPR.repository}`,
          default_branch: 'main',
        },
      },
      body: transformedPR.body,
      comments: transformedPR.comments?.length || 0,
      review_comments: 0,
      commits: 0,
      additions:
        transformedPR.file_changes?.files.reduce(
          (sum, file) => sum + file.additions,
          0
        ) || 0,
      deletions:
        transformedPR.file_changes?.files.reduce(
          (sum, file) => sum + file.deletions,
          0
        ) || 0,
      changed_files: transformedPR.file_changes?.total_count || 0,
      // Include file_changes if it was requested and fetched
      ...(transformedPR.file_changes && {
        file_changes: transformedPR.file_changes,
      }),
    };

    return {
      total_count: 1,
      incomplete_results: false,
      pull_requests: [formattedPR],
    };
  } catch (error: unknown) {
    const apiError = handleGitHubAPIError(error);
    const owner = params.owner as string;
    const repo = params.repo as string;
    const prNumber = params.prNumber!;

    return {
      error: `Failed to fetch pull request #${prNumber}: ${apiError.error}`,
      status: apiError.status,
      rateLimitRemaining: apiError.rateLimitRemaining,
      rateLimitReset: apiError.rateLimitReset,
      hints: [
        `Verify that pull request #${prNumber} exists in ${owner}/${repo}`,
        'Check if you have access to this repository',
        'Ensure the PR number is correct',
      ],
      type: apiError.type,
    };
  }
}
