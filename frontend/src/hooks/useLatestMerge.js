import { useQuery } from '@tanstack/react-query'

// API configuration - use proxy in development, env var in production
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

const fetchLatestMerge = async (type) => {
  const response = await fetch(`${API_BASE_URL}/latest-merge/${type}`)

  if (!response.ok) {
    throw new Error(`Failed to fetch latest merge for ${type}: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

export const useLatestMerge = (type) => {
  return useQuery({
    queryKey: ['latest-merge', type],
    queryFn: () => fetchLatestMerge(type),
    refetchInterval: 60000, // Refresh every minute
    staleTime: 30000, // Consider data stale after 30 seconds
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  })
}

// Hook for both backend and frontend latest merge data
export const useLatestMerges = () => {
  const backendQuery = useLatestMerge('backend')
  const frontendQuery = useLatestMerge('frontend')

  return {
    backend: backendQuery,
    frontend: frontendQuery,
    isLoading: backendQuery.isLoading || frontendQuery.isLoading,
    isError: backendQuery.isError || frontendQuery.isError,
    error: backendQuery.error || frontendQuery.error
  }
}