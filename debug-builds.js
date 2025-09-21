const fs = require('fs');
const data = JSON.parse(fs.readFileSync('builds_data.json'));

console.log('Main Test Builds (PR# column):');
data.mainTestBuilds.slice(0, 10).forEach(b => {
  const component = b.projectName.includes('backend') ? 'backend' : 'frontend';
  console.log(`${component}: ${b.projectName} - commit: ${b.commit} - PR: ${b.prNumber || 'none'}`);
});

console.log('\nLatest commits from API:');
console.log('backend: a6b9380');
console.log('frontend: 4a4913a');

console.log('\nChecking if builds should be out of date:');
data.mainTestBuilds.slice(0, 5).forEach(b => {
  const component = b.projectName.includes('backend') ? 'backend' : 'frontend';
  const latestCommit = component === 'backend' ? 'a6b9380' : '4a4913a';
  const buildCommit = b.commit;
  const shouldBeOutOfDate = buildCommit !== latestCommit && buildCommit !== latestCommit.substring(0, 7);
  console.log(`${component} ${b.projectName}: ${buildCommit} vs ${latestCommit} -> should be out of date: ${shouldBeOutOfDate}`);
});