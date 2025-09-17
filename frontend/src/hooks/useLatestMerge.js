import { useQuery } from '@tanstack/react-query'

// API configuration - use proxy in development, env var in production
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

const fetchLatestMerge = async (type, branch = 'main') => {
  const response = await fetch(`${API_BASE_URL}/latest-merge/${type}/${branch}`)

  if (!response.ok) {
    throw new Error(`Failed to fetch latest merge for ${type}/${branch}: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

export const useLatestMerge = (type, branch = 'main') => {
  return useQuery({
    queryKey: ['latest-merge', type, branch],
    queryFn: () => fetchLatestMerge(type, branch),
    refetchInterval: 60000, // Refresh every minute
    staleTime: 30000, // Consider data stale after 30 seconds
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  })
}

// Hook for both backend and frontend latest merge data for both main and dev branches
export const useLatestMerges = () => {
  const backendMainQuery = useLatestMerge('backend', 'main')
  const frontendMainQuery = useLatestMerge('frontend', 'main')
  const backendDevQuery = useLatestMerge('backend', 'dev')
  const frontendDevQuery = useLatestMerge('frontend', 'dev')

  return {
    backend: backendMainQuery,
    frontend: frontendMainQuery,
    backendDev: backendDevQuery,
    frontendDev: frontendDevQuery,
    isLoading: backendMainQuery.isLoading || frontendMainQuery.isLoading || backendDevQuery.isLoading || frontendDevQuery.isLoading,
    isError: backendMainQuery.isError || frontendMainQuery.isError || backendDevQuery.isError || frontendDevQuery.isError,
    error: backendMainQuery.error || frontendMainQuery.error || backendDevQuery.error || frontendDevQuery.error
  }
}