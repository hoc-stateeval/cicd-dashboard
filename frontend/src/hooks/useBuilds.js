import { useQuery } from '@tanstack/react-query'

// API configuration - points to local Express server
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002'

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
    refetchInterval: 30000, // Refresh every 30 seconds
    staleTime: 15000, // Consider data stale after 15 seconds
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  })
}

// Hook for manual refresh
export const useRefreshBuilds = () => {
  const { refetch } = useBuilds()
  return refetch
}