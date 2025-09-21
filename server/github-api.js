const https = require('https');

// Enhanced GitHub API Cache with TTL and request deduplication
class GitHubAPICache {
  constructor() {
    this.cache = new Map();
    this.pendingRequests = new Map(); // For request deduplication
    this.maxSize = 1000; // Prevent memory leaks

    // Cache TTL settings (in milliseconds)
    this.TTL = {
      STATIC: 0,           // Never expires (commit messages, PR numbers)
      SEMI_STATIC: 30 * 60 * 1000,  // 30 minutes (branch latest commits)
      DYNAMIC: 5 * 60 * 1000,       // 5 minutes (comparison results)
    };

    // Cleanup expired entries every 10 minutes
    setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  _createCacheEntry(data, ttl = this.TTL.STATIC) {
    return {
      data,
      timestamp: Date.now(),
      expires: ttl > 0 ? Date.now() + ttl : 0 // 0 = never expires
    };
  }

  _isExpired(entry) {
    return entry.expires > 0 && Date.now() > entry.expires;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (this._isExpired(entry)) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set(key, data, ttl = this.TTL.STATIC) {
    // Implement LRU eviction if cache is too large
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, this._createCacheEntry(data, ttl));
  }

  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (this._isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  // Request deduplication - prevents multiple simultaneous requests for same data
  async deduplicate(key, requestFn) {
    // Check cache first
    if (this.has(key)) {
      return this.get(key);
    }

    // Check if request is already pending
    if (this.pendingRequests.has(key)) {
      return await this.pendingRequests.get(key);
    }

    // Make the request and cache it for other concurrent calls
    const promise = requestFn().then(result => {
      this.pendingRequests.delete(key);
      return result;
    }).catch(error => {
      this.pendingRequests.delete(key);
      throw error;
    });

    this.pendingRequests.set(key, promise);
    return await promise;
  }

  cleanup() {
    let cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (this._isExpired(entry)) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`🧹 GitHub cache: cleaned ${cleaned} expired entries`);
    }
  }

  getStats() {
    const now = Date.now();
    let expired = 0;
    for (const entry of this.cache.values()) {
      if (this._isExpired(entry)) expired++;
    }

    return {
      total: this.cache.size,
      expired,
      active: this.cache.size - expired,
      pending: this.pendingRequests.size
    };
  }
}

// Helper function to extract PR title from commit message
const extractPRTitleFromCommitMessage = (message) => {
  if (!message) return null;

  // Look for GitHub merge commit patterns
  const mergePatterns = [
    /^Merge pull request #\d+ from .+\n\n(.+)/,
    /^Merge pull request #\d+ from .+\n(.+)/,
    /^\(#\d+\)\s*(.+)/
  ];

  for (const pattern of mergePatterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
};

// GitHub API class that encapsulates all GitHub operations
class GitHubAPI {
  constructor() {
    this.cache = new GitHubAPICache();
  }

  // Get common headers for GitHub API requests
  _getHeaders() {
    const headers = {
      'User-Agent': 'CI-Dashboard',
      'Accept': 'application/vnd.github.v3+json'
    };

    // Add GitHub token if available
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    return headers;
  }

  // Get commit message from GitHub API
  async getCommitMessage(repo, commitSha) {
    if (!commitSha) return null;

    const cacheKey = `commit-msg-${repo}-${commitSha}`;
    return await this.cache.deduplicate(cacheKey, async () => {
      try {
        const url = `https://api.github.com/repos/hoc-stateeval/${repo}/commits/${commitSha}`;
        const headers = this._getHeaders();

        if (process.env.GITHUB_TOKEN) {
          console.log(`🔑 Using GitHub authentication for ${repo}:${commitSha}`);
        } else {
          console.log(`⚠️  No GITHUB_TOKEN found - using unauthenticated requests (may fail for private repos)`);
        }

        const result = await new Promise((resolve) => {
          const req = https.get(url, { headers }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                if (res.statusCode === 200) {
                  const commit = JSON.parse(data);
                  const message = commit.commit?.message;
                  resolve(message);
                } else {
                  console.log(`GitHub API error for ${commitSha}: ${res.statusCode}`);
                  resolve(null);
                }
              } catch (e) {
                console.error(`Error parsing GitHub response for ${commitSha}:`, e.message);
                resolve(null);
              }
            });
          });

          req.on('error', (e) => {
            console.error(`GitHub API request error for ${commitSha}:`, e.message);
            resolve(null);
          });

          // Timeout after 5 seconds
          req.setTimeout(5000, () => {
            req.destroy();
            resolve(null);
          });
        });

        // Cache the result (STATIC TTL since commit messages never change)
        this.cache.set(cacheKey, result, this.cache.TTL.STATIC);
        return result;

      } catch (error) {
        console.error(`Error fetching commit ${commitSha}:`, error.message);
        return null;
      }
    });
  }

  // Get full commit details from GitHub API for hotfix detection
  async getCommitDetails(repo, commitSha) {
    if (!commitSha) return null;

    const cacheKey = `commit-details-${repo}-${commitSha}`;
    return await this.cache.deduplicate(cacheKey, async () => {
      try {
        const url = `https://api.github.com/repos/hoc-stateeval/${repo}/commits/${commitSha}`;
        const headers = this._getHeaders();

        const result = await new Promise((resolve) => {
          const req = https.get(url, { headers }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                if (res.statusCode === 200) {
                  const commit = JSON.parse(data);
                  const commitDetails = {
                    message: commit.commit?.message || 'No message',
                    author: {
                      name: commit.commit?.author?.name || 'Unknown',
                      email: commit.commit?.author?.email || '',
                      username: commit.author?.login || null
                    },
                    date: commit.commit?.author?.date || null,
                    sha: commit.sha,
                    parents: commit.parents || [],
                    isHotfix: false // Will be determined later
                  };

                  resolve(commitDetails);
                } else {
                  console.log(`GitHub API error for commit details ${commitSha}: ${res.statusCode}`);
                  resolve(null);
                }
              } catch (e) {
                console.error(`Error parsing GitHub commit details for ${commitSha}:`, e.message);
                resolve(null);
              }
            });
          });

          req.on('error', (e) => {
            console.error(`GitHub API request error for commit details ${commitSha}:`, e.message);
            resolve(null);
          });

          // Timeout after 5 seconds
          req.setTimeout(5000, () => {
            req.destroy();
            resolve(null);
          });
        });

        // Cache the result (STATIC TTL since commit details never change)
        this.cache.set(cacheKey, result, this.cache.TTL.STATIC);
        return result;

      } catch (error) {
        console.error(`Error fetching commit details ${commitSha}:`, error.message);
        return null;
      }
    });
  }

  // Get full PR details including title from GitHub API
  async getPRDetails(commitSha, repo) {
    if (!commitSha) return null;

    const cacheKey = `pr-details-${repo}-${commitSha}`;
    return await this.cache.deduplicate(cacheKey, async () => {
      try {
        const response = await fetch(`https://api.github.com/repos/hoc-stateeval/${repo}/commits/${commitSha}/pulls`, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            ...(process.env.GITHUB_TOKEN && { 'Authorization': `token ${process.env.GITHUB_TOKEN}` })
          }
        });

        if (!response.ok) {
          console.log(`⚠️ GitHub API error for PR details ${commitSha.substring(0,8)}: ${response.status}`);
          return null;
        }

        const pulls = await response.json();

        if (pulls && pulls.length > 0) {
          // Find the merged PR or the most recent one
          const mergedPR = pulls.find(pr => pr.merged_at) || pulls[0];
          console.log(`🔗 Found PR #${mergedPR.number} "${mergedPR.title}" for commit ${commitSha.substring(0,8)}`);

          const prDetails = {
            number: mergedPR.number,
            title: mergedPR.title,
            body: mergedPR.body,
            state: mergedPR.state,
            merged_at: mergedPR.merged_at,
            user: mergedPR.user?.login,
            url: mergedPR.html_url
          };

          // Cache with STATIC TTL since PR details never change
          this.cache.set(cacheKey, prDetails, this.cache.TTL.STATIC);
          return prDetails;
        }

        console.log(`❌ No PR found for commit ${commitSha.substring(0,8)}`);
        return null;

      } catch (error) {
        console.error(`❌ Error fetching PR details from GitHub for commit ${commitSha.substring(0,8)}:`, error.message);
        return null;
      }
    });
  }

  // Fetch latest merge info with API format (used by /api/latest-merge/:repo/:branch)
  async fetchLatestMergeApiLogic(repo, branch = 'main') {
    // Validate repo parameter
    if (!['backend', 'frontend'].includes(repo)) {
      throw new Error('Repository must be either "backend" or "frontend"');
    }

    const cacheKey = `latest-merge-api-${repo}-${branch}`;
    return await this.cache.deduplicate(cacheKey, async () => {
      console.log(`📊 Fetching latest merge info for ${repo} via API format...`);

      const url = `https://api.github.com/repos/hoc-stateeval/${repo}/commits/${branch}`;
      const headers = this._getHeaders();

      const response = await fetch(url, { headers });

      if (!response.ok) {
        throw new Error(`GitHub API responded with ${response.status}`);
      }

      const commitData = await response.json();

      // Extract PR title from commit message or use first line as fallback
      const fullMessage = commitData.commit.message;
      const prTitle = extractPRTitleFromCommitMessage(fullMessage);
      const displayMessage = prTitle || fullMessage.split('\n')[0];

      const result = {
        repo: repo,
        latestCommit: {
          sha: commitData.sha,
          shortSha: commitData.sha.substring(0, 8),
          message: displayMessage,
          author: commitData.commit.author.name,
          date: commitData.commit.author.date,
          url: commitData.html_url
        }
      };

      console.log(`✅ Latest merge info for ${repo}: ${result.latestCommit.shortSha}`);

      // Cache with moderate TTL (5 minutes) for responsive red indicators while avoiding rate limits
      this.cache.set(cacheKey, result, 5 * 60 * 1000); // 5 minutes
      return result;
    });
  }


  // Get cache statistics
  getCacheStats() {
    return this.cache.getStats();
  }
}

// Export a singleton instance
module.exports = new GitHubAPI();