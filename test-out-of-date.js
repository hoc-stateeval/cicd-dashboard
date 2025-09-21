// Test script to verify out-of-date logic
const buildCommits = {
  'eval-frontend-mainbranchtest': '4e8f331', // Should be out of date vs 4a4913a
  'eval-backend-mainbranchtest': '586f6b7'   // Should be out of date vs a6b9380
}

const latestCommits = {
  'frontend': '4a4913a',
  'backend': 'a6b9380'
}

console.log('=== Out-of-Date Test Results ===')

Object.entries(buildCommits).forEach(([project, buildCommit]) => {
  const componentType = project.includes('frontend') ? 'frontend' : 'backend'
  const latestCommit = latestCommits[componentType]

  // Simulate the comparison logic from BuildRow.jsx
  const isOutOfDate = buildCommit !== latestCommit && buildCommit !== latestCommit.substring(0, 7)

  console.log(`${project}:`)
  console.log(`  Build commit: ${buildCommit}`)
  console.log(`  Latest commit: ${latestCommit}`)
  console.log(`  Out of date: ${isOutOfDate ? '🔺 YES (should show red indicator)' : '✅ NO'}`)
  console.log('')
})

console.log('Expected behavior:')
console.log('- Frontend main branch test builds should show 🔺 red indicator')
console.log('- Backend main branch test builds should show 🔺 red indicator')