import { useQuery } from '@tanstack/react-query'

// API configuration - use proxy in development, env var in production
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

const fetchBuilds = async () => {
  const response = await fetch(`${API_BASE_URL}/builds`)
  
  if (!response.ok) {
    throw new Error(`Failed to fetch builds: ${response.status} ${response.statusText}`)
  }
  
  return response.json()
}

export const useBuilds = () => {
  return useQuery({
    queryKey: ['builds'],
    queryFn: fetchBuilds,
    refetchInterval: false, // No automatic refresh - build history is static
    staleTime: Infinity, // Build data never becomes stale (historical data)
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  })
}

// Hook for manual refresh
export const useRefreshBuilds = () => {
  const { refetch } = useBuilds()
  return refetch
}